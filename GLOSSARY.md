# Domain glossary

- **Game**: a kind of dedicated server the panel can run (`starbound`,
  `factorio`). Stored as the `game` label on Hetzner servers and snapshots. A
  missing label means `starbound`.
- **World**: one named save lineage, identified by its Hetzner server name
  (`server-name` label). A world is either *live* (a Hetzner server exists) or
  *dormant* (only snapshots exist).
- **Live / dormant / pending**: the card states. *Pending* means a start/stop
  flow is running and no server is visible yet.
- **Save & stop**: soft shutdown → snapshot → delete the server.
- **Fresh install / new world**: create a server from a stock Ubuntu image,
  with game-specific cloud-init `user_data` that installs the game and, for
  Factorio, generates a map.
- **Upgrade** (Factorio): restore a world with `user_data` that swaps the
  binaries to a newer version. See `docs/design/factorio-support.md` D8.
- **Game DNS record**: the per-game Gandi record (`GANDI_RECORD_<GAME>`) that
  points at that game's single live server.
- **Fake upstreams**: local stand-ins for external services, served from one
  HTTP router (`dev/fake-upstreams.ts`) with a mount per upstream. Today that
  is the **Hetzner emulator** (mounted at `/hetzner`) and an optional fake
  factorio.com.
- **Hetzner emulator / local backend**: a dev-only, Docker-backed stand-in for
  Hetzner (`dev/emulator/`), started by `pnpm dev:local` and reached through
  `HETZNER_API_URL`. It speaks the Hetzner JSON shapes the panel reads and runs
  real game servers locally: a server is a container from the base image, fed
  the game's unchanged `user_data` through a cloud-init NoCloud seed. Docker is
  the source of truth (managed `sbp.*` labels), so worlds survive restarts of
  `pnpm dev:local`. Never deployed.
- **DNS provider**: the DNS service the start flow uses to update a game DNS
  record, chosen with `DNS_PROVIDER` (`gandi`, the default, or `none`). The
  `none` provider makes no network calls and reports `localhost` with the
  server's IPs.

Design decisions: [`docs/design/`](docs/design/).
