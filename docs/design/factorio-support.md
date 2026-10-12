# Design: Factorio support (multi-game panel)

Status: **decided, not implemented**. Decisions come from a design interview on
2026-10-12. Terms are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Goal

Run a Factorio headless server from the same panel, using the same lifecycle as
Starbound: create from a snapshot, save & stop, snapshot, delete. A Starbound
world and a Factorio world can be live **at the same time**.

## Decisions

| # | Topic | Decision |
|---|-------|----------|
| D1 | Concurrency / DNS | Both games can run at once. **Per-game DNS record**: `GANDI_RECORD_<GAME>` (e.g. `GANDI_RECORD_FACTORIO=factorio`), falling back to `GANDI_RECORD` for Starbound only, so existing setups keep working. |
| D2 | Game identity | New `game` label (`starbound` \| `factorio`) on servers **and** snapshots. If the label is missing, the game is `starbound`, so existing snapshots need no migration. |
| D3 | Multiple worlds | Several dormant worlds per game are allowed. **At most one live server per game**: the panel refuses to start a second one, because both would claim the game's DNS record. Enforce this server-side in `startServerInit`, not only in the UI. |
| D4 | Fresh Factorio world | The "new world" form has **seed**, **preset** (`default`, `rich-resources`, `marathon`, `death-world`, `death-world-marathon`, `rail-world`, `ribbon-world`, `island`), **peaceful** and **no enemies** toggles, plus optional **raw JSON** for `map-gen-settings.json` / `map-settings.json`. Raw JSON wins over the form fields. cloud-init writes the files and runs `--create`. |
| D5 | Space Age | Off by default (the owner doesn't have it). cloud-init writes `mod-list.json` with `space-age`, `quality` and `elevated-rails` disabled. A checkbox in the form can turn them on. |
| D6 | Version (fresh) | Install the latest stable headless build. The server function resolves "latest" to a concrete version **before** calling create, so the `factorio-version` label is exact. |
| D7 | Version tracking | Latest version comes from `factorio.com/api/latest-releases` (`stable.headless`). Installed version is stored in the `factorio-version` label on the server and copied to the snapshot (like `server-type` / `location` today). |
| D8 | Upgrade | When the latest version is newer than the world's `factorio-version`, the card shows an **UPGRADE** action. It works **through cloud-init on restore**: a server created from a snapshot is a new instance, so cloud-init runs its `user_data`. Upgrading a dormant world means starting it with upgrade `user_data` (download version X, replace the binaries, keep `saves/` and config, restart the service) and the new version label. Upgrading a live world means save & stop first, then the same. No SSH key or on-box agent. The previous snapshot (retention ≥ 2) is the rollback. |
| D9 | Joining | Server is **unlisted** (`public: false`, `lan: true`). `FACTORIO_GAME_PASSWORD` (optional) and `FACTORIO_ADMINS` (comma-separated) env vars go into `server-settings.json` / `server-adminlist.json`. No factorio.com credentials needed. |
| D10 | Firewall | **One firewall per game**: the existing `starbound-panel` (TCP/UDP 21025) stays, and a new `starbound-panel-factorio` opens UDP 34197. Both also allow SSH and ICMP. The game definition owns its ports. |
| D11 | Server size | Per-game default type: `HETZNER_SERVER_TYPE_FACTORIO`, default `cx33`. `HETZNER_SERVER_TYPE` stays the Starbound default. |
| D12 | Branding | The UI becomes generic (e.g. "GAME CONTROL") and each card shows a game badge. The label `managed=starbound-panel` and the firewall name stay, so existing snapshots and the firewall keep working. Renaming the repo is out of scope. |

## Shape of the change

### Game registry (`src/lib/games.ts`, new)

One object per game, so the rest of the code stops branching on string
literals:

```ts
interface GameDefinition {
  id: "starbound" | "factorio";
  label: string;                 // badge text
  firewallName: string;          // D10
  ports: { protocol: "tcp" | "udp"; port: string }[];
  defaultServerType: () => string; // D11, reads env
  dnsRecord: () => string | undefined; // D1, reads env
  freshInstallUserData(opts): string;  // replaces buildCloudInit
  upgradeUserData?(version: string): string; // D8, factorio only
}
```

`buildCloudInit` moves to the Starbound entry unchanged, Steam credentials
included.

### Server side

- `createServer` / `takeSnapshot`: set and copy the `game` label, plus
  `factorio-version` for Factorio. `getLatestSnapshot` / `cleanupOldSnapshots`
  keep selecting by `server-name`; names are unique per Hetzner project.
- `ensureFirewall(game)`: look up or create by `game.firewallName`.
- `startServerInit` takes `game`, fresh-world options (D4/D5) and an optional
  `upgradeTo` version. It rejects the start if a live server with the same
  `game` label exists (D3).
- `updateDnsForServer`: get the record from the server's `game` label.
  `gandi.server.ts` takes the record name as a parameter.
- New `getLatestFactorioVersion` server function, cached for ~1 h.

### Client side

- `buildDormantList` / entity types gain `game` (and `factorioVersion`).
- `FreshCard` is no longer "only when nothing exists". There is a
  **"new world"** entry per game, and Factorio opens the map-gen form (D4/D5).
  New world names need validation for Hetzner name rules and must not clash.
- Factorio cards show the installed version and an **UPGRADE** button when it
  is outdated (D8). The upgrade flow is the existing stop flow (if live)
  followed by the start flow with `upgradeTo`.

### Factorio cloud-init outline (fresh install)

```bash
useradd -m factorio
curl -L https://factorio.com/get-download/$VERSION/headless/linux64 | tar -xJ -C /opt
# write data: map-gen-settings.json, map-settings.json, server-settings.json,
#             server-adminlist.json, mods/mod-list.json (space-age off)
/opt/factorio/bin/x64/factorio --create /opt/factorio/saves/world.zip \
  [--preset P] [--map-gen-seed S] --map-gen-settings ... --map-settings ...
# systemd unit: factorio --start-server /opt/factorio/saves/world.zip \
#   --server-settings ... --server-adminlist ...
```

`systemctl stop` sends SIGTERM, which makes Factorio save before exiting. The
stop flow relies on this (Hetzner `shutdown` sends ACPI, then systemd stops the
unit). **Check during implementation** that the unit has a long enough
`TimeoutStopSec` for big saves.

## Verify during implementation

These could not be checked from the design session (factorio.com was not
reachable):

- Response shape of `https://factorio.com/api/latest-releases` and the
  `get-download/<version>/headless/linux64` URL / archive format.
- In 2.0, `peaceful_mode` and `no_enemies_mode` live in
  `map-gen-settings.json`. Confirm this, and confirm how `--preset` combines
  with `--map-gen-settings`.
- The mod names to disable for "no Space Age" (`space-age`, `quality`,
  `elevated-rails`).
- That a Hetzner server created from a snapshot re-runs cloud-init `user_data`
  (new instance-id), and that a normal restore with no `user_data` does nothing.

## Out of scope

- Uploading an existing save through the panel. Use `scp` into
  `/opt/factorio/saves/` instead.
- Public server listing.
- Mod management beyond the Space Age toggle.
- Upgrading Starbound.
