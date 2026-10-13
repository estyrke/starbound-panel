// Fake Hetzner Cloud API: a stateful in-memory simulation of the endpoints the
// panel uses. Servers and snapshot images move through their lifecycle on a
// timer (settled lazily on every request), so the GUI's pending/live/dormant
// transitions are visible without any real infrastructure.

import type { FakeRequest, FakeResponse, FakeRouter } from "./types.ts";

export interface FakeHetznerOptions {
  // How long create / power / snapshot actions take to finish.
  actionDelayMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  seed?: boolean;
}

interface FakeServer {
  id: number;
  name: string;
  status: string;
  created: number;
  labels: Record<string, string>;
  serverType: string;
  location: string;
  image: string;
  ipv4: string;
  ipv6Net: string;
  // The status the server moves to once `at` has passed.
  transition?: { to: string; at: number };
}

interface FakeImage {
  id: number;
  description: string;
  created: number;
  labels: Record<string, string>;
  availableAt: number;
}

interface FakeAction {
  id: number;
  command: string;
  started: number;
  finishesAt: number;
  resources: { id: number; type: string }[];
}

type Labels = Record<string, string>;

const err = (status: number, code: string, message: string): FakeResponse => ({
  status,
  body: { error: { code, message, details: null } },
});

const iso = (ms: number) => new Date(ms).toISOString();

// Supports the selector forms the panel uses (`k=v`, comma separated) plus
// `k!=v` and bare `k`. Values are decoded since the panel pre-encodes them.
export function matchesLabelSelector(labels: Labels, selector: string | null): boolean {
  if (!selector) return true;
  return selector
    .split(",")
    .filter(Boolean)
    .every((term) => {
      const neq = term.indexOf("!=");
      if (neq > 0) return labels[term.slice(0, neq)] !== decode(term.slice(neq + 2));
      const eq = term.indexOf("=");
      if (eq > 0) return labels[term.slice(0, eq)] === decode(term.slice(eq + 1));
      return term in labels;
    });
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pagination(total: number, perPage: number) {
  return {
    pagination: {
      page: 1,
      per_page: perPage,
      previous_page: null,
      next_page: null,
      last_page: 1,
      total_entries: total,
    },
  };
}

export function createFakeHetzner({
  actionDelayMs = 2500,
  now = Date.now,
  log = console.log,
  seed = true,
}: FakeHetznerOptions = {}): FakeRouter {
  const servers = new Map<number, FakeServer>();
  const images = new Map<number, FakeImage>();
  const actions = new Map<number, FakeAction>();
  const firewalls = new Map<number, { id: number; name: string; rules: unknown[] }>();
  let nextId = 10_000_000;
  let nextIp = 10;

  const newId = () => nextId++;

  function addServer(init: {
    name: string;
    labels: Labels;
    serverType: string;
    location: string;
    image: string;
    status: string;
    created: number;
  }): FakeServer {
    const n = nextIp++;
    const server: FakeServer = {
      id: newId(),
      ...init,
      ipv4: `203.0.113.${n % 255}`,
      ipv6Net: `2001:db8:${n.toString(16)}::/64`,
    };
    servers.set(server.id, server);
    return server;
  }

  function addAction(command: string, resources: FakeAction["resources"], delay = actionDelayMs) {
    const t = now();
    const action: FakeAction = {
      id: newId(),
      command,
      started: t,
      finishesAt: t + delay,
      resources,
    };
    actions.set(action.id, action);
    return action;
  }

  // Applies every timed transition that is due.
  function settle() {
    const t = now();
    for (const s of servers.values()) {
      if (s.transition && s.transition.at <= t) {
        s.status = s.transition.to;
        s.transition = undefined;
      }
    }
  }

  const actionJson = (a: FakeAction) => {
    const done = a.finishesAt <= now();
    return {
      id: a.id,
      command: a.command,
      status: done ? "success" : "running",
      progress: done
        ? 100
        : Math.min(99, Math.round(((now() - a.started) / (a.finishesAt - a.started)) * 100)),
      started: iso(a.started),
      finished: done ? iso(a.finishesAt) : null,
      resources: a.resources,
      error: null,
    };
  };

  const serverJson = (s: FakeServer) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    created: iso(s.created),
    public_net: {
      ipv4: { ip: s.ipv4, blocked: false, dns_ptr: `${s.ipv4.replaceAll(".", "-")}.fake.invalid` },
      ipv6: { ip: s.ipv6Net, blocked: false, dns_ptr: [] },
      floating_ips: [],
      firewalls: [],
    },
    private_net: [],
    server_type: {
      id: 1,
      name: s.serverType,
      description: s.serverType,
      cores: 2,
      memory: 4,
      disk: 40,
    },
    datacenter: { id: 1, name: `${s.location}-dc1`, location: { name: s.location } },
    location: { id: 1, name: s.location, city: "Fake City", country: "FI" },
    image: { id: 1, name: s.image, type: "system" },
    labels: s.labels,
    protection: { delete: false, rebuild: false },
    rescue_enabled: false,
    locked: false,
  });

  const imageJson = (i: FakeImage) => ({
    id: i.id,
    type: "snapshot",
    status: i.availableAt <= now() ? "available" : "creating",
    name: null,
    description: i.description,
    created: iso(i.created),
    image_size: 1.5,
    disk_size: 40,
    os_flavor: "ubuntu",
    os_version: "22.04",
    labels: i.labels,
    protection: { delete: false },
    deprecated: null,
  });

  if (seed) {
    const t = now();
    const day = 86_400_000;
    const base = { location: "hel1", image: "ubuntu-22.04", status: "running", created: t - day };
    addServer({
      ...base,
      name: "starbound",
      serverType: "cx23",
      labels: { managed: "starbound-panel", game: "starbound" },
    });
    // A dormant Factorio world on an older version, plus an older snapshot of
    // the live Starbound world.
    const snaps: [string, Labels][] = [
      [
        "factory",
        {
          managed: "starbound-panel",
          game: "factorio",
          "server-name": "factory",
          "server-type": "cx33",
          location: "hel1",
          "factorio-version": "2.0.10",
        },
      ],
      [
        "starbound",
        {
          managed: "starbound-panel",
          game: "starbound",
          "server-name": "starbound",
          "server-type": "cx23",
          location: "hel1",
        },
      ],
    ];
    snaps.forEach(([name, labels], idx) => {
      const id = newId();
      images.set(id, {
        id,
        description: `starbound:${name}`,
        created: t - 2 * day - idx * 3_600_000,
        labels,
        availableAt: 0,
      });
    });
  }

  function createServer(body: Record<string, unknown>): FakeResponse {
    const name = body.name;
    const serverType = body.server_type;
    const image = body.image;
    if (typeof name !== "string" || !name) return err(422, "invalid_input", "name is required");
    if (typeof serverType !== "string") return err(422, "invalid_input", "server_type is required");
    if (typeof image !== "string") return err(422, "invalid_input", "image is required");
    if ([...servers.values()].some((s) => s.name === name)) {
      return err(409, "uniqueness_error", "server name is already used");
    }
    if (/^\d+$/.test(image) && !images.has(Number(image))) {
      return err(422, "invalid_input", `image ${image} not found`);
    }
    const t = now();
    const server = addServer({
      name,
      labels: (body.labels as Labels | undefined) ?? {},
      serverType,
      location: typeof body.location === "string" ? body.location : "hel1",
      image,
      status: "initializing",
      created: t,
    });
    server.transition = { to: "running", at: t + actionDelayMs };
    const action = addAction("create_server", [{ id: server.id, type: "server" }]);
    log(`[fake-hetzner] create server ${name} (#${server.id}) from ${image}`);
    return {
      status: 201,
      body: {
        server: serverJson(server),
        action: actionJson(action),
        next_actions: [],
        root_password: null,
      },
    };
  }

  function serverAction(server: FakeServer, command: string): FakeResponse {
    const t = now();
    const resources = [{ id: server.id, type: "server" }];
    switch (command) {
      case "poweron":
        if (server.status === "off") {
          server.status = "starting";
          server.transition = { to: "running", at: t + actionDelayMs };
        }
        break;
      case "poweroff":
      case "shutdown":
        server.transition = { to: "off", at: t + actionDelayMs };
        break;
      case "reboot":
        break;
      default:
        return err(404, "not_found", `unknown action ${command}`);
    }
    log(`[fake-hetzner] ${command} server ${server.name} (#${server.id})`);
    return { status: 201, body: { action: actionJson(addAction(command, resources)) } };
  }

  function createImage(server: FakeServer, body: Record<string, unknown>): FakeResponse {
    const t = now();
    const id = newId();
    const delay = actionDelayMs * 2;
    images.set(id, {
      id,
      description: typeof body.description === "string" ? body.description : "",
      created: t,
      labels: (body.labels as Labels | undefined) ?? {},
      availableAt: t + delay,
    });
    const action = addAction(
      "create_image",
      [
        { id: server.id, type: "server" },
        { id, type: "image" },
      ],
      delay
    );
    log(`[fake-hetzner] snapshot of ${server.name} -> image #${id}`);
    return { status: 201, body: { image: imageJson(images.get(id)!), action: actionJson(action) } };
  }

  return (req: FakeRequest) => {
    // The client's base URL may or may not already include the /v1 prefix.
    const path = req.path.replace(/^\/v1(?=\/)/, "");
    const m = req.method;
    settle();

    if (m === "GET" && path === "/servers") {
      const name = req.query.get("name");
      const list = [...servers.values()].filter(
        (s) =>
          (!name || s.name === name) &&
          matchesLabelSelector(s.labels, req.query.get("label_selector"))
      );
      return {
        status: 200,
        body: { servers: list.map(serverJson), meta: pagination(list.length, 25) },
      };
    }
    if (m === "POST" && path === "/servers")
      return createServer((req.body ?? {}) as Record<string, unknown>);

    const sm = /^\/servers\/(\d+)(?:\/actions\/(\w+))?$/.exec(path);
    if (sm) {
      const server = servers.get(Number(sm[1]));
      if (!server) return err(404, "not_found", "server not found");
      if (!sm[2] && m === "GET") return { status: 200, body: { server: serverJson(server) } };
      if (!sm[2] && m === "DELETE") {
        servers.delete(server.id);
        log(`[fake-hetzner] delete server ${server.name} (#${server.id})`);
        return {
          status: 200,
          body: {
            action: actionJson(addAction("delete_server", [{ id: server.id, type: "server" }], 0)),
          },
        };
      }
      if (sm[2] === "create_image" && m === "POST") {
        return createImage(server, (req.body ?? {}) as Record<string, unknown>);
      }
      if (sm[2] && m === "POST") return serverAction(server, sm[2]);
    }

    const am = /^\/actions\/(\d+)$/.exec(path);
    if (am && m === "GET") {
      const action = actions.get(Number(am[1]));
      return action
        ? { status: 200, body: { action: actionJson(action) } }
        : err(404, "not_found", "action not found");
    }

    if (m === "GET" && path === "/images") {
      let list = [...images.values()].filter((i) =>
        matchesLabelSelector(i.labels, req.query.get("label_selector"))
      );
      if (req.query.get("sort")?.startsWith("created:desc"))
        list.sort((a, b) => b.created - a.created);
      const total = list.length;
      const perPage = Number(req.query.get("per_page")) || 25;
      list = list.slice(0, perPage);
      return {
        status: 200,
        body: { images: list.map(imageJson), meta: pagination(total, perPage) },
      };
    }
    const im = /^\/images\/(\d+)$/.exec(path);
    if (im && m === "DELETE") {
      return images.delete(Number(im[1]))
        ? { status: 204 }
        : err(404, "not_found", "image not found");
    }

    if (m === "GET" && path === "/firewalls") {
      const name = req.query.get("name");
      const list = [...firewalls.values()].filter((f) => !name || f.name === name);
      return { status: 200, body: { firewalls: list, meta: pagination(list.length, 25) } };
    }
    if (m === "POST" && path === "/firewalls") {
      const body = (req.body ?? {}) as { name?: string; rules?: unknown[] };
      if (!body.name) return err(422, "invalid_input", "name is required");
      const fw = { id: newId(), name: body.name, rules: body.rules ?? [] };
      firewalls.set(fw.id, fw);
      return { status: 201, body: { firewall: fw, actions: [] } };
    }

    if (m === "GET" && path === "/ssh_keys") {
      return { status: 200, body: { ssh_keys: [], meta: pagination(0, 25) } };
    }
    return undefined;
  };
}
