// Hetzner Cloud JSON shapes the panel's client reads, plus the error shape.

import type { FakeResponse } from "../types.ts";
import type { Labels } from "./label-selector.ts";

export const iso = (ms: number) => new Date(ms).toISOString();

export const err = (status: number, code: string, message: string): FakeResponse => ({
  status,
  body: { error: { code, message, details: null } },
});

export function pagination(total: number, perPage = 25) {
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

export interface ServerView {
  id: number;
  name: string;
  status: "running" | "off" | "starting" | "initializing";
  created: number;
  labels: Labels;
  serverType: string;
  location: string;
  image: string;
}

// Local worlds are always reachable on the developer's own machine.
export const PUBLIC_IPV4 = "127.0.0.1";
export const PUBLIC_IPV6_NET = "::/64";

export const serverJson = (s: ServerView) => ({
  id: s.id,
  name: s.name,
  status: s.status,
  created: iso(s.created),
  public_net: {
    ipv4: { ip: PUBLIC_IPV4, blocked: false, dns_ptr: "localhost" },
    ipv6: { ip: PUBLIC_IPV6_NET, blocked: false, dns_ptr: [] },
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
  location: { id: 1, name: s.location, city: "Local", country: "FI" },
  image: { id: 1, name: s.image, type: "system" },
  labels: s.labels,
  protection: { delete: false, rebuild: false },
  rescue_enabled: false,
  locked: false,
});

// Docker operations are synchronous, so every action is already finished.
export function finishedAction(
  id: number,
  command: string,
  at: number,
  resources: { id: number; type: string }[]
) {
  return {
    id,
    command,
    status: "success",
    progress: 100,
    started: iso(at),
    finished: iso(at),
    resources,
    error: null,
  };
}

export interface SnapshotView {
  id: number;
  description: string;
  created: number;
  labels: Labels;
}

export const snapshotJson = (i: SnapshotView) => ({
  id: i.id,
  type: "snapshot",
  status: "available",
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
