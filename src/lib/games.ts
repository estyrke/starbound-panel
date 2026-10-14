// Game registry: everything that differs per game. Pure data plus pure
// functions of the environment, so the world plan builder stays testable.

export type Env = Record<string, string | undefined>;

export type GameId = "starbound" | "factorio";

export interface FirewallPort {
  protocol: "tcp" | "udp";
  port: string;
}

// Factorio seeds are unsigned 32-bit integers.
export const MAX_SEED = 4_294_967_295;

export const FACTORIO_PRESETS = [
  "default",
  "rich-resources",
  "marathon",
  "death-world",
  "death-world-marathon",
  "rail-world",
  "ribbon-world",
  "island",
] as const;

// Map-gen choices for a new Factorio world. Raw JSON wins over the form fields.
export interface FactorioMapOptions {
  seed?: string;
  preset?: string;
  peaceful?: boolean;
  noEnemies?: boolean;
  mapGenSettingsJson?: string;
  mapSettingsJson?: string;
  spaceAge?: boolean;
}

export interface Game {
  id: GameId;
  label: string;
  firewall: { name: string; ports: FirewallPort[] };
  // Server type used when the caller doesn't pick one, from the environment.
  defaultServerType: (env: Env) => string;
  // Label key holding the installed game version, for games that track one.
  versionLabel?: string;
  // DNS record name for this game's server, resolved from the environment.
  dnsRecord: (env: Env) => string;
  // Cloud-init for a fresh install, or a refusal reason if not possible.
  // `version` is the resolved game version for games with a versionLabel.
  userData: (
    env: Env,
    version?: string,
    options?: FactorioMapOptions
  ) => { ok: true; userData: string } | { ok: false; error: string };
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
  defaultServerType: (env) => env.HETZNER_SERVER_TYPE ?? "cx23",
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

// Cloud-init for a fresh Factorio install: headless build of `version`, a
// default-map save, and a systemd unit whose SIGTERM stop writes the save.
// Space Age and its dependent DLC mods are off unless chosen.
function factorioCloudInit(env: Env, version: string, options: FactorioMapOptions): string {
  // Raw JSON wins over the form fields (preset, peaceful, no enemies).
  const rawMapGen = options.mapGenSettingsJson?.trim();
  const rawMapSettings = options.mapSettingsJson?.trim();
  const mapGen: object | null = rawMapGen
    ? JSON.parse(rawMapGen)
    : options.peaceful || options.noEnemies
      ? {
          ...(options.peaceful && { peaceful_mode: true }),
          ...(options.noEnemies && {
            autoplace_controls: { "enemy-base": { frequency: 1, size: 0, richness: 1 } },
          }),
        }
      : null;
  const mapSettings: object | null = rawMapSettings
    ? JSON.parse(rawMapSettings)
    : options.noEnemies && !rawMapGen
      ? { enemy_expansion: { enabled: false } }
      : null;
  const createFlags = [
    options.seed ? ` --map-gen-seed ${options.seed}` : "",
    options.preset && !rawMapGen ? ` --preset ${options.preset}` : "",
    mapGen ? " --map-gen-settings /opt/factorio/map-gen-settings.json" : "",
    mapSettings ? " --map-settings /opt/factorio/map-settings.json" : "",
  ].join("");
  // Re-serialised so the heredoc can't be ended early by raw input.
  const settingsFiles = (
    [
      ["map-gen-settings.json", mapGen],
      ["map-settings.json", mapSettings],
    ] as const
  )
    .filter(([, v]) => v)
    .map(([f, v]) => `cat > /opt/factorio/${f} << 'JSON'\n${JSON.stringify(v)}\nJSON\n`)
    .join("");
  const password = JSON.stringify(env.FACTORIO_GAME_PASSWORD ?? "");
  const admins = JSON.stringify(
    (env.FACTORIO_ADMINS ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean)
  );
  const settings = `{
  "name": "Factorio",
  "description": "",
  "visibility": { "public": false, "lan": true },
  "game_password": ${password},
  "require_user_verification": false,
  "autosave_interval": 10,
  "autosave_only_on_server": true
}`;
  const mods = ["base", "space-age", "quality", "elevated-rails"]
    .map((n) => `{ "name": "${n}", "enabled": ${n === "base" || !!options.spaceAge} }`)
    .join(",\n    ");
  const modList = `{
  "mods": [
    ${mods}
  ]
}`;
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y xz-utils curl
useradd -m -s /bin/bash factorio 2>/dev/null || true
curl -fL https://factorio.com/get-download/${version}/headless/linux64 | tar -xJ -C /opt
mkdir -p /opt/factorio/saves /opt/factorio/mods
cat > /opt/factorio/server-settings.json << 'JSON'
${settings}
JSON
cat > /opt/factorio/server-adminlist.json << 'JSON'
${admins}
JSON
cat > /opt/factorio/mods/mod-list.json << 'JSON'
${modList}
JSON
${settingsFiles}chown -R factorio:factorio /opt/factorio
su factorio -c '/opt/factorio/bin/x64/factorio --create /opt/factorio/saves/world.zip${createFlags}'
cat > /etc/systemd/system/factorio.service << 'SERVICE'
[Unit]
Description=Factorio Headless Server
After=network.target

[Service]
User=factorio
WorkingDirectory=/opt/factorio
ExecStart=/opt/factorio/bin/x64/factorio --start-server /opt/factorio/saves/world.zip --server-settings /opt/factorio/server-settings.json --server-adminlist /opt/factorio/server-adminlist.json
KillSignal=SIGTERM
TimeoutStopSec=300
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable factorio
systemctl start factorio
`;
}

const factorio: Game = {
  id: "factorio",
  label: "Factorio",
  firewall: { name: "starbound-panel-factorio", ports: [{ protocol: "udp", port: "34197" }] },
  defaultServerType: (env) => env.HETZNER_SERVER_TYPE_FACTORIO ?? "cx33",
  versionLabel: "factorio-version",
  dnsRecord: (env) => env.GANDI_RECORD_FACTORIO ?? "@",
  userData: (env, version, options = {}) => {
    if (!version) return { ok: false, error: "Factorio version is required for a fresh install" };
    return { ok: true, userData: factorioCloudInit(env, version, options) };
  },
};

export const GAMES: Record<GameId, Game> = { starbound, factorio };

export const DEFAULT_GAME: GameId = "starbound";

// A server or snapshot with no (or unknown) game label counts as Starbound.
export function gameIdOf(labels: Record<string, string> | undefined): GameId {
  const g = labels?.game;
  return g && g in GAMES ? (g as GameId) : DEFAULT_GAME;
}
