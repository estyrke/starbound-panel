// Drives the panel's real Hetzner client against the Docker-backed emulator,
// so a green run means the emulator speaks what the panel expects. Skipped
// when Docker or the base image is unavailable.

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteServer, getServer, listServers, listSnapshots } from "../../src/lib/hetzner.server";
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
});
