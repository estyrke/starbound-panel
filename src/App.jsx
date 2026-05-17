import { useState, useEffect, useCallback, useMemo } from "react";
import styles from "./App.module.css";

const STATUS_COLOR = {
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

const STATUS_LABEL = {
  running: "ONLINE",
  off: "OFFLINE",
  stopping: "STOPPING",
  starting: "STARTING",
  initializing: "INITIALISERAR",
  rebuilding: "REBUILDING",
  migrating: "MIGRATING",
  deleting: "RADERAR",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatAge(created) {
  if (!created) return "—";
  const diff = Math.floor((Date.now() - new Date(created)) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m}m`;
}

function ts() {
  return new Date().toLocaleTimeString("sv-SE");
}

export default function App() {
  const [servers, setServers] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // opState: { [serverName]: { phase: string, label: string } }
  // Tracks in-progress multi-step operations so cards can show live status.
  const [opState, setOpState] = useState({});
  const [log, setLog] = useState([]);
  const [tick, setTick] = useState(0);

  const addLog = useCallback((msg) => {
    setLog((prev) => [`[${ts()}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [sRes, snapRes] = await Promise.all([
        fetch("/api/servers"),
        fetch("/api/snapshots"),
      ]);
      if (!sRes.ok) throw new Error(`HTTP ${sRes.status}`);
      const sData = await sRes.json();
      const snapData = snapRes.ok ? await snapRes.json() : { images: [] };
      setServers(sData.servers || []);
      setSnapshots(snapData.images || []);
      setError(null);
    } catch (e) {
      setError(e.message);
      if (!silent) addLog(`Fel vid hämtning: ${e.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [addLog]);

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

  const setOp = (name, phase, label) =>
    setOpState((s) => ({ ...s, [name]: { phase, label } }));
  const clearOp = (name) =>
    setOpState((s) => { const n = { ...s }; delete n[name]; return n; });

  // Poll servers list until the given server reaches targetStatus (or is gone when targetStatus=null)
  const waitForServerStatus = useCallback(async (serverId, targetStatus) => {
    for (let i = 0; i < 90; i++) {
      await sleep(4000);
      const r = await fetch("/api/servers");
      if (!r.ok) continue;
      const { servers: list } = await r.json();
      setServers(list || []);
      const found = (list || []).find((s) => s.id === serverId);
      if (targetStatus === null && !found) return null;
      if (found?.status === targetStatus) return found;
    }
    throw new Error("Timeout: servern svarar inte");
  }, []);

  // Poll a Hetzner action until it succeeds or errors
  const waitForAction = useCallback(async (actionId) => {
    for (let i = 0; i < 90; i++) {
      await sleep(4000);
      const r = await fetch(`/api/poll-action?id=${actionId}`);
      if (!r.ok) continue;
      const data = await r.json();
      if (data.action?.status === "success") return;
      if (data.action?.status === "error")
        throw new Error(data.action.error?.message || "Åtgärden misslyckades");
    }
    throw new Error("Timeout: åtgärden tog för lång tid");
  }, []);

  // Full stop flow: graceful shutdown → snapshot → delete
  const doStop = useCallback(async (server) => {
    const { name, id } = server;
    addLog(`Sparar och stänger av ${name}…`);
    try {
      setOp(name, "stopping", "Stänger av…");
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "shutdown" }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`); }

      await waitForServerStatus(id, "off");

      setOp(name, "snapshotting", "Skapar snapshot…");
      addLog(`${name}: av – skapar snapshot`);
      const snapRes = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: id }),
      });
      if (!snapRes.ok) { const d = await snapRes.json(); throw new Error(d.error || `HTTP ${snapRes.status}`); }
      const snapData = await snapRes.json();
      if (snapData.action?.id) await waitForAction(snapData.action.id);

      setOp(name, "deleting", "Raderar server…");
      addLog(`${name}: snapshot klar – raderar server`);
      const delRes = await fetch("/api/delete-server", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: id }),
      });
      if (!delRes.ok) { const d = await delRes.json(); throw new Error(d.error || `HTTP ${delRes.status}`); }

      addLog(`✓ ${name} sparad och stängd`);
      await fetchAll(true);
    } catch (e) {
      addLog(`✗ ${name}: ${e.message}`);
    } finally {
      clearOp(name);
    }
  }, [addLog, fetchAll, waitForServerStatus, waitForAction]);

  // Full start flow: create server from snapshot (or cloud-init for first launch)
  const doStart = useCallback(async ({ name, serverType, location, snapshotId }) => {
    addLog(snapshotId ? `Startar ${name} från snapshot…` : `Startar ${name} – installerar från grunden…`);
    try {
      setOp(name, "creating", "Skapar server…");
      const r = await fetch("/api/create-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId, name, serverType, location }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`); }
      const data = await r.json();
      const newId = data.server?.id;

      setOp(name, "booting", "Väntar på start…");
      addLog(`${name}: server skapad – väntar på start`);
      let liveServer = null;
      if (newId) liveServer = await waitForServerStatus(newId, "running");

      const ip = liveServer?.public_net?.ipv4?.ip;
      // Hetzner gives IPv6 as a network (e.g. "2a01:4f8::/64"); the server sits at ::1
      const ipv6Network = liveServer?.public_net?.ipv6?.ip;
      const ipv6 = ipv6Network ? ipv6Network.split("/")[0].replace(/::$/, "::1") : null;
      if (ip || ipv6) {
        setOp(name, "dns", "Uppdaterar DNS…");
        addLog(`${name}: online (${ip ?? ipv6}) – uppdaterar DNS`);
        const dnsRes = await fetch("/api/update-dns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip, ipv6 }),
        });
        const dnsData = await dnsRes.json();
        if (dnsRes.ok) addLog(`✓ DNS uppdaterad: ${dnsData.record} A→${ip} AAAA→${ipv6}`);
        else addLog(`⚠ DNS misslyckades: ${dnsData.error}`);
      }

      addLog(`✓ ${name} online`);
      await fetchAll(true);
    } catch (e) {
      addLog(`✗ ${name}: ${e.message}`);
    } finally {
      clearOp(name);
    }
  }, [addLog, fetchAll, waitForServerStatus]);

  // Simple single-step actions (reboot, poweron for manually-stopped servers)
  const doAction = useCallback(async (server, action) => {
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
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      addLog(`✓ ${label} ${server.name} – åtgärd startad`);
      setTimeout(() => fetchAll(true), 2000);
      setTimeout(() => fetchAll(true), 5000);
      setTimeout(() => fetchAll(true), 10000);
    } catch (e) {
      addLog(`✗ Fel: ${e.message}`);
    } finally {
      clearOp(server.name);
    }
  }, [addLog, fetchAll]);

  // Merge servers + snapshots into a unified entity list for rendering
  const entities = useMemo(() => {
    const liveByName = Object.fromEntries(servers.map((s) => [s.name, s]));

    // Keep only the newest snapshot per server name
    const latestSnap = {};
    for (const snap of snapshots) {
      const name = snap.labels?.["server-name"] || snap.description?.replace("starbound:", "") || "unknown";
      const existing = latestSnap[name];
      if (!existing || new Date(snap.created) > new Date(existing.snap.created)) {
        latestSnap[name] = { snap, name };
      }
    }

    const result = [];

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
          serverType: snap.labels?.["server-type"],
          location: snap.labels?.location,
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
                const { server, name } = entity;
                const op = opState[name];
                const isBusy = !!op || ["starting", "stopping", "rebuilding"].includes(server.status);
                return (
                  <LiveCard
                    key={entity.key}
                    server={server}
                    op={op}
                    isBusy={isBusy}
                    onStop={() => doStop(server)}
                    onReboot={() => doAction(server, "reboot")}
                    onPowerOn={() => doAction(server, "poweron")}
                  />
                );
              }
              if (entity.type === "dormant") {
                return (
                  <DormantCard
                    key={entity.key}
                    name={entity.name}
                    serverType={entity.serverType}
                    location={entity.location}
                    snapshot={entity.snapshot}
                    onStart={() => doStart({
                      name: entity.name,
                      serverType: entity.serverType,
                      location: entity.location,
                      snapshotId: entity.snapshot.id,
                    })}
                  />
                );
              }
              if (entity.type === "pending") {
                return <PendingCard key={entity.key} name={entity.name} op={entity.op} />;
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
                <div key={i} className={styles.logEntry}>{entry}</div>
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

function LiveCard({ server, op, isBusy, onStop, onReboot, onPowerOn }) {
  const isOn = server.status === "running";
  const statusColor = op ? "var(--yellow)" : (STATUS_COLOR[server.status] || "var(--text-dim)");
  const statusLabel = op ? op.label.toUpperCase() : (STATUS_LABEL[server.status] || server.status.toUpperCase());

  return (
    <div className={`${styles.card} ${isOn && !op ? styles.cardOn : ""}`}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>{server.name}</div>
          <div className={styles.serverMeta}>
            {server.server_type?.name} · {server.datacenter?.location?.name?.toUpperCase() || "—"}
          </div>
        </div>
        <div className={styles.statusBadge} style={{ color: statusColor }}>
          <span className={styles.statusDot} style={{ background: statusColor }} />
          {statusLabel}
        </div>
      </div>

      <div className={styles.cardStats}>
        <Stat label="IP" value={server.public_net?.ipv4?.ip || "—"} mono />
        <Stat label="CPU" value={`${server.server_type?.cores || "—"} vCPU`} />
        <Stat label="RAM" value={`${server.server_type?.memory || "—"} GB`} />
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

function DormantCard({ name, serverType, location, snapshot, onStart }) {
  return (
    <div className={`${styles.card} ${styles.cardDormant}`}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>{name}</div>
          <div className={styles.serverMeta}>
            {serverType || "—"} · {location?.toUpperCase() || "—"}
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
        <Stat label="SNAPSHOT" value={snapshot ? formatAge(snapshot.created) : "—"} />
      </div>

      <div className={styles.cardActions}>
        <ActionBtn label="STARTA" icon="▶" color="var(--green)" onClick={onStart} wide />
      </div>
    </div>
  );
}

function PendingCard({ name, op }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.serverName}>{name}</div>
          <div className={styles.serverMeta}>—</div>
        </div>
        <div className={styles.statusBadge} style={{ color: "var(--yellow)" }}>
          <span className={styles.statusDot} style={{ background: "var(--yellow)" }} />
          {op?.label?.toUpperCase() || "STARTAR…"}
        </div>
      </div>

      <div className={styles.cardStats}>
        <Stat label="IP" value="—" mono />
        <Stat label="CPU" value="—" />
        <Stat label="RAM" value="—" />
        <Stat label="PORT" value="21025" mono />
      </div>

      <div className={styles.cardActions}>
        <ActionBtn label={op?.label || "STARTAR…"} icon="…" color="var(--yellow)" disabled wide />
      </div>

      <BusyBar />
    </div>
  );
}

function FreshCard({ onStart }) {
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
            Startar en ny server och installerar Starbound via SteamCMD (kräver STEAM_USER + STEAM_PASS)
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

function Stat({ label, value, mono }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} style={mono ? { fontFamily: "var(--font-mono)" } : {}}>
        {value}
      </span>
    </div>
  );
}

function ActionBtn({ label, icon, color, onClick, disabled, loading, wide }) {
  return (
    <button
      className={`${styles.actionBtn} ${wide ? styles.actionBtnWide : ""}`}
      style={{ "--btn-color": color }}
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
