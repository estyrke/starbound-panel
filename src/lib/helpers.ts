// Pure helpers shared by the server functions, kept free of I/O so they can
// be unit-tested.

import type { DormantServer, HetznerImage } from "./types";

// Hetzner reports the IPv6 allocation as a network (e.g. "2a01:db8::/64");
// the server itself is conventionally reachable at ::1 within it.
export function deriveIpv6Host(network: string | null | undefined): string | null {
  if (!network) return null;
  return network.split("/")[0].replace(/::$/, "::1");
}

// Merge snapshots into a per-name "dormant server" list, keeping only the
// newest snapshot per name and excluding names that have a live server.
export function buildDormantList(
  servers: { name: string }[],
  snapshots: HetznerImage[]
): DormantServer[] {
  const liveNames = new Set(servers.map((s) => s.name));

  const latestSnap: Record<string, HetznerImage> = {};
  for (const snap of snapshots) {
    const name = snap.labels["server-name"] ?? snap.description.replace("starbound:", "");
    if (!latestSnap[name] || new Date(snap.created) > new Date(latestSnap[name].created)) {
      latestSnap[name] = snap;
    }
  }

  return Object.entries(latestSnap)
    .filter(([name]) => !liveNames.has(name))
    .map(([name, snap]) => ({
      name,
      snapshot: snap,
      serverType: snap.labels["server-type"],
      location: snap.labels["location"],
    }));
}

// Given snapshot ids sorted newest first, pick the ones beyond the retention
// count for deletion.
export function selectSnapshotsToDelete(idsNewestFirst: number[], retention: number): number[] {
  if (!Number.isFinite(retention) || retention < 0) {
    throw new Error(`Invalid snapshot retention count: ${retention}`);
  }
  return idsNewestFirst.slice(retention);
}
