import { useState, useEffect, useCallback, useMemo } from "react";
import styles from "./App.module.css";
import type {
  HetznerServer,
  HetznerImage,
  OpState,
  StartParams,
  Entity,
  LiveEntity,
  DormantEntity,
  PendingEntity,
} from "./types.js";

const STATUS_COLOR: Record<string, string> = {
  running: "var(--green)",
  off: "var(--red)",
  stopping: "var(--yellow)",
  starting: "var(--yellow)",
  initializing: "var(--yellow)",
  rebuilding: "var(--yellow)",
  migrating: "var(--yellow)",
  deleting: "var(--red)",
  unknown: "var(--text-dim)",
};

const STATUS_LABEL: Record<string, string> = {
  running: "ONLINE",
  off: "OFFLINE",
  stopping: "STOPPING",
  starting: "STARTING",
  initializing: "INITIALISERAR",
  rebuilding: "REBUILDING",
  migrating: "MIGRATING",
  deleting: "RADERAR",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function formatAge(created: string): string {
  const diff = Math.floor((Date.now() - new Date(created).getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m}m`;
}

function ts(): string {
  return new Date().toLocaleTimeString("sv-SE");
}

export default function App() {
  const [servers, setServers] = useState<HetznerServer[]>([]);
  const [snapshots, setSnapshots] = useState<HetznerImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // opState: tracks in-progress multi-step operations so cards can show live status
  const [opState, setOpState] = useState<Record<string, OpState>>({});
  const [log, setLog] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [`[${ts()}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  const fetchAll = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [sRes, snapRes] = await Promise.all([
          fetch("/api/servers"),
          fetch("/api/snapshots"),
        ]);
        if (!sRes.ok) throw new Error(`HTTP ${sRes.status}`);
        const sData = await sRes.json();
        const snapData = snapRes.ok ? await snapRes.json() : { images: [] };
        setServers(sData.servers ?? []);
        setSnapshots(snapData.images ?? []);
        setError(null);
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        if (!silent) addLog(`Fel vid hämtning: ${msg}`);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [addLog]
  );

  useEffect(() => {
    fetchAll();
    addLog("Panel ansluten – hämtar servrar…");
  }, [fetchAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      fetchAll(true);
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const setOp = (name: string, phase: string, label: string) =>
    setOpState((s) => ({ ...s, [name]: { phase, label } }));
  const clearOp = (name: string) =>
    setOpState((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });

  // Polls servers list until the given server reaches targetStatus (or is gone when null)
  const waitForServerStatus = useCallback(
    async (serverId: number, targetStatus: string | null): Promise<HetznerServer | null> => {
      for (let i = 0; i < 90; i++) {
        await sleep(4000);
        const r = await fetch("/api/servers");
        if (!r.ok) continue;
        const { servers: list } = (await r.json()) as { servers: HetznerServer[] };
        setServers(list ?? []);
        const found = list?.find((s) => s.id === serverId) ?? null;
        if (targetStatus === null && !found) return null;
        if (found?.status === targetStatus) return found;
      }
      throw new Error("Timeout: servern svarar inte");
    },
    []
  );

  // Polls a Hetzner action until it succeeds or errors
  const waitForAction = useCallback(async (actionId: number): Promise<void> => {
    for (let i = 0; i < 90; i++) {
      await sleep(4000);
      const r = await fetch(`/api/poll-action?id=${actionId}`);
      if (!r.ok) continue;
      const data = await r.json();
      if (data.action?.status === "success") return;
      if (data.action?.status === "error")
        throw new Error(data.action.error?.message ?? "Åtgärden misslyckades");
    }
    throw new Error("Timeout: åtgärden tog för lång tid");
  }, []);

  // Full stop flow: graceful shutdown → snapshot → delete
  const doStop = useCallback(
    async (server: HetznerServer) => {
      const { name, id } = server;
      addLog(`Sparar och stänger av ${name}…`);
      try {
        setOp(name, "stopping", "Stänger av…");
        const r = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action: "shutdown" }),
        });
        if (!r.ok) {
          const d = await r.json();
          throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
        }
        await waitForServerStatus(id, "off");

        setOp(name, "snapshotting", "Skapar snapshot…");
        addLog(`${name}: av – skapar snapshot`);
        const snapRes = await fetch("/api/snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: id }),
        });
        if (!snapRes.ok) {
          const d = await snapRes.json();
          throw new Error((d as { error?: string }).error ?? `HTTP ${snapRes.status}`);
        }
        const snapData = await snapRes.json();
        if (snapData.action?.id) await waitForAction(snapData.action.id as number);

        setOp(name, "deleting", "Raderar server…");
        addLog(`${name}: snapshot klar – raderar server`);
        const delRes = await fetch("/api/delete-server", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: id }),
        });
        if (!delRes.ok) {
          const d = await delRes.json();
          throw new Error((d as { error?: string }).error ?? `HTTP ${delRes.status}`);
        }

        addLog(`✓ ${name} sparad och stängd`);
        await fetchAll(true);
      } catch (e) {
        addLog(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        clearOp(name);
      }
    },
    [addLog, fetchAll, waitForServerStatus, waitForAction]
  );

  // Full start flow: create server from snapshot (or cloud-init for first launch)
  const doStart = useCallback(
    async ({ name, serverType, location, snapshotId }: StartParams) => {
      addLog(
        snapshotId ? `Startar ${name} från snapshot…` : `Startar ${name} – installerar från grunden…`
      );
      try {
        setOp(name, "creating", "Skapar server…");
        const r = await fetch("/api/create-server", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshotId, name, serverType, location }),
        });
        if (!r.ok) {
          const d = await r.json();
          throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
        }
        const data = await r.json();
        const newId = (data.server as HetznerServer | undefined)?.id;

        setOp(name, "booting", "Väntar på start…");
        addLog(`${name}: server skapad – väntar på start`);
        let liveServer: HetznerServer | null = null;
        if (newId) liveServer = await waitForServerStatus(newId, "running");

        const ip = liveServer?.public_net.ipv4?.ip;
        // Hetzner gives IPv6 as a network (e.g. "2a01:4f8::/64"); the server sits at ::1
        const ipv6Network = liveServer?.public_net.ipv6?.ip;
        const ipv6 = ipv6Network ? ipv6Network.split("/")[0].replace(/::$/, "::1") : null;

        if (ip ?? ipv6) {
          setOp(name, "dns", "Uppdaterar DNS…");
          addLog(`${name}: online (${ip ?? ipv6}) – uppdaterar DNS`);
          const dnsRes = await fetch("/api/update-dns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ip, ipv6 }),
          });
          const dnsData = await dnsRes.json();
          if (dnsRes.ok)
            addLog(
              `✓ DNS uppdaterad: ${(dnsData as { record: string }).record} A→${ip} AAAA→${ipv6}`
            );
          else addLog(`⚠ DNS misslyckades: ${(dnsData as { error: string }).error}`);
        }

        addLog(`✓ ${name} online`);
        await fetchAll(true);
      } catch (e) {
        addLog(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        clearOp(name);
      }
    },
    [addLog, fetchAll, waitForServerStatus]
  );

  // Simple single-step actions (reboot, poweron for manually-stopped servers)
  const doAction = useCallback(
    async (server: HetznerServer, action: "reboot" | "poweron") => {
      const label = action === "reboot" ? "Startar om" : "Startar";
      setOp(server.name, action, `${label}…`);
      addLog(`${label} ${server.name}…`);
      try {
        const r = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: server.id, action }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
        addLog(`✓ ${label} ${server.name} – åtgärd startad`);
        setTimeout(() => fetchAll(true), 2000);
        setTimeout(() => fetchAll(true), 5000);
        setTimeout(() => fetchAll(true), 10000);
      } catch (e) {
        addLog(`✗ Fel: ${(e as Error).message}`);
      } finally {
        clearOp(server.name);
      }
    },
    [addLog, fetchAll]
  );

  // Merge servers + snapshots into a unified entity list for rendering
  const entities = useMemo<Entity[]>(() => {
    const liveByName = Object.fromEntries(servers.map((s) => [s.name, s]));

    // Keep only the newest snapshot per server name
    const latestSnap: Record<string, { snap: HetznerImage; name: string }> = {};
    for (const snap of snapshots) {
      const name =
        snap.labels["server-name"] ?? snap.description.replace("starbound:", "") ?? "unknown";
      const existing = latestSnap[name];
      if (!existing || new Date(snap.created) > new Date(existing.snap.created)) {
        latestSnap[name] = { snap, name };
      }
    }

    const result: Entity[] = [];

    for (const server of servers) {
      result.push({
        type: "live",
        key: `live-${server.id}`,
        server,
        snapshot: latestSnap[server.name]?.snap ?? null,
        name: server.name,
      });
    }

    for (const { name, snap } of Object.values(latestSnap)) {
      if (!liveByName[name] && !opState[name]) {
        result.push({
          type: "dormant",
          key: `dormant-${snap.id}`,
          snapshot: snap,
          name,
          serverType: snap.labels["server-type"],
          location: snap.labels["location"],
        });
      }
    }

    // Show a placeholder card for names that are mid-operation but not yet in either list
    for (const [name, op] of Object.entries(opState)) {
      if (!liveByName[name] && !latestSnap[name]) {
        result.push({ type: "pending", key: `pending-${name}`, name, op });
      }
    }

    return result;
  }, [servers, snapshots, opState]);

  const showFresh = !loading && entities.length === 0;

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span>STARBOUND</span>
          <span className={styles.logoDim}>CONTROL</span>
        </div>
        <button className={styles.refreshBtn} onClick={() => fetchAll()} disabled={loading}>
          {loading ? "↻ LADDAR…" : "↻ UPPDATERA"}
        </button>
      </header>

      <main className={styles.main}>
        {error && <div className={styles.errorBanner}>⚠ {error}</div>}

        <div className={styles.serverGrid}>
          {loading && entities.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.spinner} />
              <p>Ansluter till Hetzner Cloud…</p>
            </div>
          ) : showFresh ? (
            <FreshCard onStart={() => doStart({ name: "starbound" })} />
          ) : (
            entities.map((entity) => {
              if (entity.type === "live") {
                const e = entity as LiveEntity;
                const op = opState[e.name];
                const isBusy =
                  !!op || ["starting", "stopping", "rebuilding"].includes(e.server.status);
                return (
                  <LiveCard
                    key={e.key}
                    server={e.server}
                    op={op}
                    isBusy={isBusy}
                    onStop={() => doStop(e.server)}
                    onReboot={() => doAction(e.server, "reboot")}
                    onPowerOn={() => doAction(e.server, "poweron")}
                  />
                );
              }
              if (entity.type === "dormant") {
                const e = entity as DormantEntity;
                return (
                  <DormantCard
                    key={e.key}
                    name={e.name}
                    serverType={e.serverType}
                    location={e.location}
                    snapshot={e.snapshot}
                    onStart={() =>
                      doStart({
                        name: e.name,
                        serverType: e.serverType,
                        location: e.location,
                        snapshotId: e.snapshot.id,
                      })
                    }
                  />
                );
              }
              if (entity.type === "pending") {
                const e = entity as PendingEntity;
                return <PendingCard key={e.key} name={e.name} op={e.op} />;
              }
              return null;
            })
          )}
        </div>

        <div className={styles.logPanel}>
          <div className={styles.logHeader}>SYSTEMLOGG</div>
          <div className={styles.logBody}>
            {log.length === 0 ? (
              <span className={styles.logDim}>Inga händelser ännu.</span>
            ) : (
              log.map((entry, i) => (
                <div key={i} className={styles.logEntry}>
                  {entry}
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <span>Hetzner Cloud API</span>
        <span className={styles.footerDot}>·</span>
        <span>Auto-uppdatering var 10s</span>
        <span className={styles.footerDot}>·</span>
        <span className={styles.footerTick}>TICK {tick}</span>
      </footer>
    </div>
  );
}

// ── Card components ──────────────────────────────────────────────────────────

interface LiveCardProps {
  server: HetznerServer;
  op?: OpState;
  isBusy: boolean;
  onStop: () => void;
  onReboot: () => void;
  onPowerOn: () => void;
}

function LiveCard({ server, op, isBusy, onStop, onReboot, onPowerOn }: LiveCardProps) {
  const isOn = server.status === "running";
  const statusColor = op ? "var(--yellow)" : (STATUS_COLOR[server.status] ?? "var(--text-dim)");
  const statusLabel = op
    ? op.label.toUpperCase()
    : (STATUS_LABEL[server.status] ?? server.status.toUpperCase());

  return (
    <div className={`${styles.card} ${isOn && !op ? styles.cardOn : ""}`}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>{server.name}</div>
          <div className={styles.serverMeta}>
            {server.server_type.name} · {server.datacenter.location.name.toUpperCase()}
          </div>
        </div>
        <div className={styles.statusBadge} style={{ color: statusColor }}>
          <span className={styles.statusDot} style={{ background: statusColor }} />
          {statusLabel}
        </div>
      </div>

      <div className={styles.cardStats}>
        <Stat label="IP" value={server.public_net.ipv4?.ip ?? "—"} mono />
        <Stat label="CPU" value={`${server.server_type.cores} vCPU`} />
        <Stat label="RAM" value={`${server.server_type.memory} GB`} />
        <Stat label="PORT" value="21025" mono />
      </div>

      <div className={styles.cardActions}>
        {isOn ? (
          <>
            <ActionBtn
              label="SPARA & STÄNG"
              icon="⏻"
              color="var(--red)"
              onClick={onStop}
              disabled={isBusy}
              loading={!!op && op.phase !== "reboot"}
            />
            <ActionBtn
              label="STARTA OM"
              icon="↺"
              color="var(--yellow)"
              onClick={onReboot}
              disabled={isBusy}
              loading={op?.phase === "reboot"}
            />
          </>
        ) : (
          <ActionBtn
            label="STARTA"
            icon="▶"
            color="var(--green)"
            onClick={onPowerOn}
            disabled={isBusy}
            loading={op?.phase === "poweron"}
            wide
          />
        )}
      </div>

      {isBusy && <BusyBar />}
    </div>
  );
}

interface DormantCardProps {
  name: string;
  serverType?: string;
  location?: string;
  snapshot: HetznerImage;
  onStart: () => void;
}

function DormantCard({ name, serverType, location, snapshot, onStart }: DormantCardProps) {
  return (
    <div className={`${styles.card} ${styles.cardDormant}`}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>{name}</div>
          <div className={styles.serverMeta}>
            {serverType ?? "—"} · {location?.toUpperCase() ?? "—"}
          </div>
        </div>
        <div className={styles.statusBadge} style={{ color: "var(--accent2)" }}>
          <span className={styles.statusDot} style={{ background: "var(--accent2)" }} />
          SOVANDE
        </div>
      </div>

      <div className={styles.cardStats}>
        <Stat label="IP" value="—" mono />
        <Stat label="CPU" value="—" />
        <Stat label="RAM" value="—" />
        <Stat label="SNAPSHOT" value={formatAge(snapshot.created)} />
      </div>

      <div className={styles.cardActions}>
        <ActionBtn label="STARTA" icon="▶" color="var(--green)" onClick={onStart} wide />
      </div>
    </div>
  );
}

interface PendingCardProps {
  name: string;
  op: OpState;
}

function PendingCard({ name, op }: PendingCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>{name}</div>
          <div className={styles.serverMeta}>—</div>
        </div>
        <div className={styles.statusBadge} style={{ color: "var(--yellow)" }}>
          <span className={styles.statusDot} style={{ background: "var(--yellow)" }} />
          {op.label.toUpperCase()}
        </div>
      </div>

      <div className={styles.cardStats}>
        <Stat label="IP" value="—" mono />
        <Stat label="CPU" value="—" />
        <Stat label="RAM" value="—" />
        <Stat label="PORT" value="21025" mono />
      </div>

      <div className={styles.cardActions}>
        <ActionBtn label={op.label} icon="…" color="var(--yellow)" disabled wide />
      </div>

      <BusyBar />
    </div>
  );
}

function FreshCard({ onStart }: { onStart: () => void }) {
  return (
    <div className={`${styles.card} ${styles.cardFresh}`}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>starbound</div>
          <div className={styles.serverMeta}>Ingen server eller snapshot hittades</div>
        </div>
        <div className={styles.statusBadge} style={{ color: "var(--text-dim)" }}>
          <span className={styles.statusDot} style={{ background: "var(--text-dim)" }} />
          INAKTIV
        </div>
      </div>

      <div className={styles.cardStats}>
        <div className={`${styles.stat} ${styles.statWide}`}>
          <span className={styles.statLabel}>INFO</span>
          <span className={styles.statValue}>
            Startar en ny server och installerar Starbound via SteamCMD (kräver STEAM_USER +
            STEAM_PASS)
          </span>
        </div>
      </div>

      <div className={styles.cardActions}>
        <ActionBtn label="NYTT SPEL" icon="◆" color="var(--accent)" onClick={onStart} wide />
      </div>
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────

interface StatProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Stat({ label, value, mono }: StatProps) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span
        className={styles.statValue}
        style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

interface ActionBtnProps {
  label: string;
  icon: string;
  color: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  wide?: boolean;
}

function ActionBtn({ label, icon, color, onClick, disabled, loading, wide }: ActionBtnProps) {
  return (
    <button
      className={`${styles.actionBtn} ${wide ? styles.actionBtnWide : ""}`}
      style={{ "--btn-color": color } as React.CSSProperties}
      onClick={onClick}
      disabled={disabled}
    >
      <span className={styles.actionIcon}>{loading ? "…" : icon}</span>
      {label}
    </button>
  );
}

function BusyBar() {
  return (
    <div className={styles.busyBar}>
      <div className={styles.busyBarFill} />
    </div>
  );
}
