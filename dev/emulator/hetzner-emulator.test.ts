// Drives the panel's real Hetzner client against the Docker-backed emulator,
// so a green run means the emulator speaks what the panel expects. Skipped
// when Docker or the base image is unavailable.

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupOldSnapshots,
  deleteServer,
  getAction,
  getLatestSnapshot,
  getServer,
  listServers,
  listSnapshots,
  sendAction,
  takeSnapshot,
} from "../../src/lib/hetzner.server";
import { startFakeUpstreams, type RunningFakeUpstreams } from "../fake-upstreams";
import { checkDocker, MANAGED_LABEL } from "./docker";
import { createHetznerEmulator } from "./hetzner-emulator";

const docker = new Docker();
const problem = await checkDocker(docker);
const namespace = `test-${process.pid}-${Date.now().toString(36)}`;

let upstreams: RunningFakeUpstreams;
let origin: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await sleep(200);
  }
  throw new Error("timed out");
}

async function exec(containerId: string, cmd: string[]): Promise<{ code: number; out: string }> {
  const container = docker.getContainer(containerId);
  const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
  const stream = await ex.start({ Tty: true });
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  const info = await ex.inspect();
  return { code: info.ExitCode ?? -1, out };
}

interface ServerList {
  servers: { id: number }[];
}
interface PostResult {
  status: number;
  body: {
    firewall: { id: number };
    server: { id: number };
    action: { status: string };
    error: { code: string };
  };
}

async function post(path: string, body: unknown): Promise<PostResult> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as PostResult["body"] };
}

describe.skipIf(problem)(`hetzner emulator (${problem ?? "docker ok"})`, () => {
  beforeAll(async () => {
    upstreams = await startFakeUpstreams({
      hetzner: createHetznerEmulator({ docker, namespace, log: () => {} }),
      log: () => {},
    });
    origin = upstreams.env.HETZNER_API_URL!.replace(/\/$/, "");
    Object.assign(process.env, upstreams.env, { HETZNER_API_TOKEN: "test" });
  });

  afterAll(async () => {
    await upstreams?.close();
    const leftovers = await docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=${namespace}`] },
    });
    for (const c of leftovers) await docker.getContainer(c.Id).remove({ force: true });
    const images = await docker.listImages({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=${namespace}`] },
    });
    for (const i of images)
      await docker
        .getImage(i.Id)
        .remove({ force: true })
        .catch(() => {});
  });

  it("starts empty", async () => {
    expect(await listServers()).toEqual([]);
    expect(await listSnapshots()).toEqual([]);
  });

  it("creates a server that runs user_data, reports status and ports, and deletes it", async () => {
    const fw = await post("/firewalls", {
      name: "test-fw",
      rules: [
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0"] },
        { direction: "in", protocol: "udp", port: "34999", source_ips: ["0.0.0.0/0"] },
      ],
    });
    expect(fw.status).toBe(201);

    const created = await post("/servers", {
      name: "contract",
      server_type: "cx23",
      location: "hel1",
      image: "ubuntu-22.04",
      labels: { managed: "starbound-panel", game: "factorio", "server-name": "contract" },
      firewalls: [{ firewall: fw.body.firewall.id }],
      user_data: "#!/bin/bash\necho hello-from-user-data > /var/tmp/user-data-ran\n",
    });
    expect(created.status).toBe(201);
    const { id } = created.body.server;
    expect(typeof id).toBe("number");
    expect(created.body.action.status).toBe("success");

    const server = (await waitFor(
      () => getServer(id),
      (s) => s?.status === "running"
    ))!;
    expect(server.name).toBe("contract");
    expect(server.server_type.name).toBe("cx23");
    expect(server.location.name).toBe("hel1");
    expect(server.labels).toMatchObject({ game: "factorio", "server-name": "contract" });
    expect(server.public_net.ipv4?.ip).toBe("127.0.0.1");
    expect(server.public_net.ipv6?.ip).toBe("::/64");

    // Panel-style label selectors find it, others do not.
    const sel = (s: string) =>
      fetch(`${origin}/servers?label_selector=${s}`).then((r) => r.json() as Promise<ServerList>);
    expect((await sel("game=factorio,managed=starbound-panel")).servers).toHaveLength(1);
    expect((await sel("game=starbound")).servers).toHaveLength(0);

    // Docker published the firewall's game port (not SSH) on localhost.
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=${namespace}`] },
    });
    const containerId = containers[0].Id;
    expect(containers[0].Ports.map((p) => `${p.IP}:${p.PublicPort}/${p.Type}`)).toEqual([
      "127.0.0.1:34999/udp",
    ]);

    // cloud-init ran the user_data.
    await exec(containerId, ["cloud-init", "status", "--wait"]);
    const ran = await exec(containerId, ["cat", "/var/tmp/user-data-ran"]);
    expect(ran.out.trim()).toBe("hello-from-user-data");

    // A second server with the same name is refused in Hetzner's error shape.
    const dup = await post("/servers", {
      name: "contract",
      server_type: "cx23",
      image: "ubuntu-22.04",
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("uniqueness_error");

    // The view is rebuilt from Docker: a fresh emulator sees the same server.
    const second = await startFakeUpstreams({
      hetzner: createHetznerEmulator({ docker, namespace, log: () => {} }),
      log: () => {},
    });
    try {
      const again = (await fetch(`${second.env.HETZNER_API_URL}servers`).then((r) =>
        r.json()
      )) as ServerList;
      expect(again.servers.map((s) => s.id)).toEqual([id]);
    } finally {
      await second.close();
    }

    expect(await deleteServer(id)).toEqual({ success: true });
    await expect(getServer(id)).rejects.toThrow(/404|not found/i);
    expect(await listServers()).toEqual([]);
  }, 180_000);

  it("shuts down, snapshots, restores with progress and re-runs user_data, and applies retention", async () => {
    Object.assign(process.env, { SNAPSHOT_RETENTION_COUNT: "1" });
    const fw = await post("/firewalls", { name: "life-fw", rules: [] });
    const labels = { managed: "starbound-panel", game: "factorio", "server-name": "life" };
    const containerOf = async (id: number) => {
      const [c] = await docker.listContainers({
        all: true,
        filters: { label: [`${MANAGED_LABEL}=${namespace}`, `sbp.id=${id}`] },
      });
      return c.Id;
    };
    const create = async (image: string, userData: string) => {
      const r = await post("/servers", {
        name: "life",
        server_type: "cx23",
        location: "hel1",
        image,
        labels,
        firewalls: [{ firewall: fw.body.firewall.id }],
        user_data: userData,
      });
      expect(r.status).toBe(201);
      const id = r.body.server.id;
      const cid = await containerOf(id);
      await exec(cid, ["cloud-init", "status", "--wait"]);
      return { id, cid };
    };
    const saveAndStop = async (id: number) => {
      const shutdown = await sendAction({ action: "shutdown", id });
      const actionId = (shutdown.body as { action: { id: number; status: string } }).action;
      expect(actionId.status).toBe("success");
      expect((await getAction(actionId.id)).status).toBe("success");
      expect((await getServer(id))?.status).toBe("off");
      const snap = await takeSnapshot(id);
      const image = snap.image!;
      expect(image.type).toBe("snapshot");
      expect((await deleteServer(id)).success).toBe(true);
      return image.id;
    };

    // 1. fresh world with some progress
    const first = await create("ubuntu-22.04", "#!/bin/bash\necho first >> /var/tmp/runs\n");
    await exec(first.cid, ["bash", "-c", "echo progress > /var/tmp/progress"]);
    const snap1 = await saveAndStop(first.id);
    expect((await getLatestSnapshot("life"))?.id).toBe(snap1);
    expect((await getLatestSnapshot("life%20x")) ?? null).toBeNull();
    const withLabels = (await listSnapshots()).find((i) => i.id === snap1);
    expect(withLabels?.labels).toMatchObject(labels);

    // 2. restore from the snapshot: progress intact, new user_data runs again
    const second = await create(String(snap1), "#!/bin/bash\necho second >> /var/tmp/runs\n");
    const progress = await exec(second.cid, ["cat", "/var/tmp/progress"]);
    expect(progress.out.trim()).toBe("progress");
    const runs = await exec(second.cid, ["cat", "/var/tmp/runs"]);
    expect(runs.out.trim().split(/\s+/)).toEqual(["first", "second"]);

    // 3. second snapshot; retention keeps only the newest
    const snap2 = await saveAndStop(second.id);
    expect(snap2).toBeGreaterThan(snap1);
    expect((await getLatestSnapshot("life"))?.id).toBe(snap2);
    expect((await cleanupOldSnapshots("life")).remaining).toBe(1);
    expect((await listSnapshots()).map((i) => i.id)).toEqual([snap2]);

    // 4. restore again from the stacked image still works
    const third = await create(String(snap2), "#!/bin/bash\necho third >> /var/tmp/runs\n");
    const runs3 = await exec(third.cid, ["cat", "/var/tmp/runs"]);
    expect(runs3.out.trim().split(/\s+/)).toEqual(["first", "second", "third"]);

    // 5. reboot keeps the container and does not re-run user_data; poweroff/poweron work
    await sendAction({ action: "reboot", id: third.id });
    await waitFor(
      () => exec(third.cid, ["systemctl", "is-system-running", "--wait"]),
      (r) => r.code === 0 || r.out.includes("running")
    );
    const runsAfterReboot = await exec(third.cid, ["cat", "/var/tmp/runs"]);
    expect(runsAfterReboot.out.trim().split(/\s+/)).toEqual(["first", "second", "third"]);
    await sendAction({ action: "poweroff", id: third.id });
    expect((await getServer(third.id))?.status).toBe("off");
    await sendAction({ action: "poweron", id: third.id });
    expect((await getServer(third.id))?.status).toBe("running");
    await deleteServer(third.id);
  }, 300_000);
});
