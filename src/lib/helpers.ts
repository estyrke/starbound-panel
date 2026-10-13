// Pure helpers shared by the server functions, kept free of I/O so they can
// be unit-tested.

import { gameIdOf } from "./games";
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
    const name = snap.labels["server-name"] ?? snap.description.replace(/^(starbound|factorio):/, "");
    if (!latestSnap[name] || new Date(snap.created) > new Date(latestSnap[name].created)) {
      latestSnap[name] = snap;
    }
  }

  return Object.entries(latestSnap)
    .filter(([name]) => !liveNames.has(name))
    .map(([name, snap]) => ({
      name,
      game: gameIdOf(snap.labels),
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

// Validates a new world name against Hetzner's server-name rules (a lowercase
// hostname label) and the names already taken. Returns a Swedish error message
// to show in the UI, or null when the name is fine.
export function validateWorldName(name: string, existingNames: string[]): string | null {
  const n = name.trim();
  if (n.length === 0) return "Ange ett namn";
  if (n.length > 63) return "Namnet får vara högst 63 tecken";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(n)) {
    return "Använd bara a–z, 0–9 och bindestreck (inte först eller sist)";
  }
  if (existingNames.includes(n)) return `En värld med namnet "${n}" finns redan`;
  return null;
}
