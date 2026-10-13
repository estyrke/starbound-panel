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
  // Resolved concrete game version for a fresh install of a versioned game;
  // null/absent means it couldn't be resolved.
  gameVersion?: string | null;
  // Live servers; labels decide which game each one occupies.
  servers: { name: string; labels?: Record<string, string> }[];
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
  const name = input.name ?? env.SERVER_NAME ?? game.id;

  if (input.servers.some((s) => s.name === name)) {
    return { ok: false, error: `A server named "${name}" already exists` };
  }
  // Both worlds would claim the game's DNS record, so one live world per game.
  if (input.servers.some((s) => gameIdOf(s.labels) === game.id)) {
    return {
      ok: false,
      error: `Det finns redan en live-värld för ${game.label} – spara och stäng av den först`,
    };
  }
  if (snapshot && gameIdOf(snapshot.labels) !== game.id) {
    return { ok: false, error: `Snapshot belongs to a different game than ${game.label}` };
  }

  const request: WorldPlan["request"] = {
    name,
    image: snapshot ? snapshot.id.toString() : "ubuntu-22.04",
    server_type: input.serverType ?? game.defaultServerType(env),
    location: input.location ?? env.HETZNER_LOCATION ?? "hel1",
    labels: { managed: "starbound-panel", game: game.id },
  };

  if (game.versionLabel) {
    const version = snapshot ? snapshot.labels[game.versionLabel] : input.gameVersion;
    if (version) request.labels[game.versionLabel] = version;
  }

  if (!snapshot) {
    if (game.versionLabel && !input.gameVersion) {
      return {
        ok: false,
        error: `Could not resolve the latest ${game.label} version, so a new world can't be created`,
      };
    }
    const ud = game.userData(env, input.gameVersion ?? undefined);
    if (!ud.ok) return { ok: false, error: ud.error };
    request.user_data = ud.userData;
  }

  return { ok: true, plan: { request, firewall: game.firewall, dnsRecord: game.dnsRecord(env) } };
}
