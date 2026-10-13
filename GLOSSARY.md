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
- **Fake upstreams**: a local stand-in for the external services the panel
  talks to (Hetzner, Gandi, factorio.com), used to try out the panel without
  touching production. No real game server ever runs behind them.

Design decisions: [`docs/design/`](docs/design/).
