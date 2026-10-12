// Game registry: everything that differs per game. Pure data plus pure
// functions of the environment, so the world plan builder stays testable.

export type Env = Record<string, string | undefined>;

export type GameId = "starbound";

export interface FirewallPort {
  protocol: "tcp" | "udp";
  port: string;
}

export interface Game {
  id: GameId;
  label: string;
  firewall: { name: string; ports: FirewallPort[] };
  defaultServerType: string;
  // DNS record name for this game's server, resolved from the environment.
  dnsRecord: (env: Env) => string;
  // Cloud-init for a fresh install, or a refusal reason if not possible.
  userData: (env: Env) => { ok: true; userData: string } | { ok: false; error: string };
}

// Quote a string as a single shell word (safe for spaces and special characters).
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Cloud-init script for a fresh Starbound install via SteamCMD. Steam Guard
// must be disabled or pre-authorised on the account used.
function starboundCloudInit(steamUser: string, steamPass: string): string {
  const steamcmd = `/usr/games/steamcmd +login ${shellQuote(steamUser)} ${shellQuote(steamPass)} +force_install_dir /home/steam/starbound +app_update 211820 validate +quit`;
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
dpkg --add-architecture i386
echo steam steam/question select "I AGREE" | sudo debconf-set-selections
echo steam steam/license note '' | sudo debconf-set-selections
apt-get update -y
apt-get install -y lib32gcc-s1 libsdl2-2.0-0 steamcmd
useradd -m -s /bin/bash steam 2>/dev/null || true
su - steam -c ${shellQuote(steamcmd)}
cat > /etc/systemd/system/starbound.service << 'SERVICE'
[Unit]
Description=Starbound Dedicated Server
After=network.target

[Service]
User=steam
WorkingDirectory=/home/steam/starbound/linux
ExecStart=/home/steam/starbound/linux/starbound_server
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable starbound
systemctl start starbound
`;
}

const starbound: Game = {
  id: "starbound",
  label: "Starbound",
  firewall: {
    name: "starbound-panel",
    ports: [
      { protocol: "tcp", port: "21025" },
      { protocol: "udp", port: "21025" },
    ],
  },
  defaultServerType: "cx23",
  dnsRecord: (env) => env.GANDI_RECORD_STARBOUND ?? env.GANDI_RECORD ?? "@",
  userData: (env) => {
    if (!env.STEAM_USER || !env.STEAM_PASS) {
      return {
        ok: false,
        error:
          "STEAM_USER and STEAM_PASS env vars are required for a fresh install (no snapshot found)",
      };
    }
    return { ok: true, userData: starboundCloudInit(env.STEAM_USER, env.STEAM_PASS) };
  },
};

export const GAMES: Record<GameId, Game> = { starbound };

export const DEFAULT_GAME: GameId = "starbound";

// A server or snapshot with no (or unknown) game label counts as Starbound.
export function gameIdOf(labels: Record<string, string> | undefined): GameId {
  const g = labels?.game;
  return g && g in GAMES ? (g as GameId) : DEFAULT_GAME;
}
