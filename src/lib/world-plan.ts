// Pure builder turning a game, a world and the current servers into either a
// refusal or a plan. The server functions only do I/O around the plan.

import { GAMES, gameIdOf, type Env, type FirewallPort, type GameId } from "./games";

export interface WorldPlanInput {
  game: GameId;
  name?: string;
  serverType?: string;
  location?: string;
  // Present when restoring a dormant world from its latest snapshot.
  snapshot?: { id: number; labels: Record<string, string> } | null;
  servers: { name: string }[];
  env: Env;
}

export interface WorldPlan {
  // Hetzner create request, minus the I/O-derived ssh keys and firewall id.
  request: {
    name: string;
    image: string;
    server_type: string;
    location: string;
    labels: Record<string, string>;
    user_data?: string;
  };
  firewall: { name: string; ports: FirewallPort[] };
  dnsRecord: string;
}

export type WorldPlanResult = { ok: true; plan: WorldPlan } | { ok: false; error: string };

export function buildWorldPlan(input: WorldPlanInput): WorldPlanResult {
  const game = GAMES[input.game];
  const { env, snapshot } = input;
  const name = input.name ?? env.SERVER_NAME ?? "starbound";

  if (input.servers.some((s) => s.name === name)) {
    return { ok: false, error: `A server named "${name}" already exists` };
  }
  if (snapshot && gameIdOf(snapshot.labels) !== game.id) {
    return { ok: false, error: `Snapshot belongs to a different game than ${game.label}` };
  }

  const request: WorldPlan["request"] = {
    name,
    image: snapshot ? snapshot.id.toString() : "ubuntu-22.04",
    server_type: input.serverType ?? env.HETZNER_SERVER_TYPE ?? game.defaultServerType,
    location: input.location ?? env.HETZNER_LOCATION ?? "hel1",
    labels: { managed: "starbound-panel", game: game.id },
  };

  if (!snapshot) {
    const ud = game.userData(env);
    if (!ud.ok) return { ok: false, error: ud.error };
    request.user_data = ud.userData;
  }

  return { ok: true, plan: { request, firewall: game.firewall, dnsRecord: game.dnsRecord(env) } };
}
