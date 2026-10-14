// Docker-backed Hetzner emulator: speaks the subset of the Hetzner Cloud API
// the panel uses and backs it with real containers. Docker is the source of
// truth (see the label scheme in docker.ts); the only in-memory state is
// short-lived action records and the firewalls the panel creates, which exist
// just to answer list/create calls and to say which ports to publish.
//
// Layout for extending it (server actions, snapshots, images, restore):
//   - add routes to the `route` function at the bottom, one handler each
//   - `listServers` / `findServer` rebuild the Hetzner view from containers;
//     snapshots will be the same over images with L.kind = "snapshot"
//   - `createServerFrom` takes the image to run, so restore from a snapshot
//     is the same call with the snapshot image

import Docker from "dockerode";
import type { FakeRequest, FakeResponse, FakeRouter } from "../types.ts";
import {
  BASE_IMAGE,
  DEFAULT_NAMESPACE,
  exposedPorts,
  L,
  MANAGED_LABEL,
  nocloudSeedTar,
  PLATFORM,
  SEED_DIR,
  serverLabels,
  systemdHostConfig,
} from "./docker.ts";
import { err, finishedAction, pagination, serverJson, type ServerView } from "./hetzner-json.ts";
import { matchesLabelSelector, type Labels } from "./label-selector.ts";
import { publishedPorts, type FirewallRule } from "./ports.ts";

export interface HetznerEmulatorOptions {
  docker?: Docker;
  // Isolates this emulator's containers from others (tests use their own).
  namespace?: string;
  log?: (line: string) => void;
}

interface Firewall {
  id: number;
  name: string;
  rules: FirewallRule[];
}

type Resource = { id: number; type: string };
type Action = ReturnType<typeof finishedAction>;

export function createHetznerEmulator({
  docker = new Docker(),
  namespace = DEFAULT_NAMESPACE,
  log = console.log,
}: HetznerEmulatorOptions = {}): FakeRouter {
  const firewalls = new Map<number, Firewall>();
  const actions = new Map<number, Action>();
  let lastId = 0;

  // Hetzner-style numeric ids: millisecond timestamps, strictly increasing.
  const newId = () => (lastId = Math.max(lastId + 1, Date.now()));

  const finish = (command: string, resources: Resource[]): Action => {
    const action = finishedAction(newId(), command, Date.now(), resources);
    actions.set(action.id, action);
    return action;
  };

  // The container is named after the Hetzner server so `docker exec` is easy.
  const containerName = (name: string) =>
    namespace === DEFAULT_NAMESPACE ? `sbp-${name}` : `sbp-${namespace}-${name}`;

  // ---- Docker -> Hetzner view -------------------------------------------

  const ownFilter = (kind: string) => [`${MANAGED_LABEL}=${namespace}`, `${L.kind}=${kind}`];

  async function listServers(): Promise<ServerView[]> {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ownFilter("server") },
    });
    return containers
      .map((c) => {
        const l = c.Labels;
        return {
          id: Number(l[L.id]),
          name: l[L.name],
          status: statusOf(c.State),
          created: Number(l[L.created]),
          labels: JSON.parse(l[L.labels] || "{}") as Labels,
          serverType: l[L.serverType],
          location: l[L.location],
          image: l[L.image],
        };
      })
      .sort((a, b) => a.id - b.id);
  }

  const findServer = async (id: number) => (await listServers()).find((s) => s.id === id);

  const containerOf = async (id: number) => {
    const [c] = await docker.listContainers({
      all: true,
      filters: { label: [...ownFilter("server"), `${L.id}=${id}`] },
    });
    return c ? docker.getContainer(c.Id) : undefined;
  };

  // ---- Handlers ---------------------------------------------------------

  async function handleListServers(req: FakeRequest): Promise<FakeResponse> {
    const name = req.query.get("name");
    const list = (await listServers()).filter(
      (s) =>
        (!name || s.name === name) &&
        matchesLabelSelector(s.labels, req.query.get("label_selector"))
    );
    return { status: 200, body: { servers: list.map(serverJson), meta: pagination(list.length) } };
  }

  async function resolveImage(image: string): Promise<{ ref: string } | undefined> {
    if (!/^\d+$/.test(image)) return { ref: BASE_IMAGE };
    return undefined; // snapshot images arrive with the snapshot ticket
  }

  async function handleCreateServer(body: Record<string, unknown>): Promise<FakeResponse> {
    const { name, server_type: serverType, image } = body;
    if (typeof name !== "string" || !name) return err(422, "invalid_input", "name is required");
    if (typeof serverType !== "string") return err(422, "invalid_input", "server_type is required");
    if (typeof image !== "string") return err(422, "invalid_input", "image is required");
    if ((await listServers()).some((s) => s.name === name)) {
      return err(409, "uniqueness_error", "server name is already used");
    }
    const source = await resolveImage(image);
    if (!source) return err(422, "invalid_input", `image ${image} not found`);

    const rules = ((body.firewalls as { firewall: number }[] | undefined) ?? []).flatMap(
      (f) => firewalls.get(f.firewall)?.rules ?? []
    );
    const ports = publishedPorts(rules);
    const id = newId();
    const created = Date.now();
    const location = typeof body.location === "string" ? body.location : "hel1";
    const labels = (body.labels as Labels | undefined) ?? {};

    const container = await docker.createContainer({
      name: containerName(name),
      Hostname: name,
      Image: source.ref,
      platform: PLATFORM,
      Labels: serverLabels(namespace, { id, name, serverType, location, created, image, labels }),
      ExposedPorts: exposedPorts(ports),
      HostConfig: systemdHostConfig(ports),
    } as Docker.ContainerCreateOptions);
    try {
      // A fresh instance-id per container makes cloud-init run user_data on
      // first boot, including when the image is a committed snapshot.
      await container.putArchive(
        nocloudSeedTar(`i-${id}`, typeof body.user_data === "string" ? body.user_data : undefined),
        { path: SEED_DIR }
      );
      if (body.start_after_create !== false) await container.start();
    } catch (e) {
      await container.remove({ force: true }).catch(() => {});
      return err(422, "invalid_input", (e as Error).message);
    }

    const server = await findServer(id);
    log(
      `[hetzner-emulator] create server ${name} (#${id}) from ${image}` +
        (ports.length ? `, ports ${ports.map((p) => `${p.port}/${p.protocol}`).join(", ")}` : "")
    );
    const action = finish("create_server", [{ id, type: "server" }]);
    return {
      status: 201,
      body: { server: serverJson(server!), action, next_actions: [], root_password: null },
    };
  }

  async function handleDeleteServer(id: number): Promise<FakeResponse> {
    const container = await containerOf(id);
    if (!container) return err(404, "not_found", "server not found");
    await container.remove({ force: true, v: true });
    log(`[hetzner-emulator] delete server #${id}`);
    return { status: 200, body: { action: finish("delete_server", [{ id, type: "server" }]) } };
  }

  function handleCreateFirewall(body: { name?: string; rules?: FirewallRule[] }): FakeResponse {
    if (!body.name) return err(422, "invalid_input", "name is required");
    const fw = { id: newId(), name: body.name, rules: body.rules ?? [] };
    firewalls.set(fw.id, fw);
    return { status: 201, body: { firewall: fw, actions: [] } };
  }

  // ---- Router -----------------------------------------------------------

  return async (req) => {
    // The client's base URL may or may not already include the /v1 prefix.
    const path = req.path.replace(/^\/v1(?=\/)/, "");
    const m = req.method;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      if (m === "GET" && path === "/servers") return await handleListServers(req);
      if (m === "POST" && path === "/servers") return await handleCreateServer(body);

      const sm = /^\/servers\/(\d+)$/.exec(path);
      if (sm) {
        const id = Number(sm[1]);
        if (m === "GET") {
          const server = await findServer(id);
          return server
            ? { status: 200, body: { server: serverJson(server) } }
            : err(404, "not_found", "server not found");
        }
        if (m === "DELETE") return await handleDeleteServer(id);
      }

      const am = /^\/actions\/(\d+)$/.exec(path);
      if (am && m === "GET") {
        const action = actions.get(Number(am[1]));
        return action
          ? { status: 200, body: { action } }
          : err(404, "not_found", "action not found");
      }

      if (m === "GET" && path === "/firewalls") {
        const name = req.query.get("name");
        const list = [...firewalls.values()].filter((f) => !name || f.name === name);
        return { status: 200, body: { firewalls: list, meta: pagination(list.length) } };
      }
      if (m === "POST" && path === "/firewalls") return handleCreateFirewall(body);

      if (m === "GET" && path === "/ssh_keys") {
        return { status: 200, body: { ssh_keys: [], meta: pagination(0) } };
      }
    } catch (e) {
      log(`[hetzner-emulator] ${m} ${path} failed: ${(e as Error).message}`);
      return err(500, "server_error", (e as Error).message);
    }
    return undefined;
  };
}

// Running is `running`, anything else (exited, created, dead) is `off`.
function statusOf(state: string): ServerView["status"] {
  if (state === "running") return "running";
  if (state === "restarting") return "starting";
  return "off";
}
