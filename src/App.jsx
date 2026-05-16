import { useState, useEffect, useCallback } from "react";
import styles from "./App.module.css";

const STATUS_COLOR = {
  running: "var(--green)",
  off: "var(--red)",
  stopping: "var(--yellow)",
  starting: "var(--yellow)",
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
  rebuilding: "REBUILDING",
  migrating: "MIGRATING",
  deleting: "DELETING",
};

function formatUptime(created) {
  if (!created) return "—";
  const diff = Math.floor((Date.now() - new Date(created)) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function App() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionState, setActionState] = useState({}); // { [serverId]: 'loading' | null }
  const [log, setLog] = useState([]);
  const [tick, setTick] = useState(0);

  const addLog = (msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("sv-SE");
    setLog((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  };

  const fetchServers = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch("/api/servers");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setServers(data.servers || []);
      setError(null);
    } catch (e) {
      setError(e.message);
      if (!silent) addLog(`Fel vid hämtning: ${e.message}`, "error");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
    addLog("Panel ansluten – hämtar servrar…");
  }, [fetchServers]);

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      fetchServers(true);
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchServers]);

  const doAction = async (server, action) => {
    const labels = {
      poweron: "Startar",
      poweroff: "Stänger av (hårt)",
      shutdown: "Stänger av (mjukt)",
      reboot: "Startar om",
    };
    setActionState((s) => ({ ...s, [server.id]: action }));
    addLog(`${labels[action] || action} ${server.name}…`);
    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: server.id, action }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      addLog(`✓ ${labels[action]} ${server.name} – åtgärd startad`);
      // Poll more aggressively for a bit
      setTimeout(() => fetchServers(true), 2000);
      setTimeout(() => fetchServers(true), 5000);
      setTimeout(() => fetchServers(true), 10000);
    } catch (e) {
      addLog(`✗ Fel: ${e.message}`, "error");
    } finally {
      setActionState((s) => ({ ...s, [server.id]: null }));
    }
  };

  const status = (s) => s.status || "unknown";
  const isOn = (s) => status(s) === "running";
  const isBusy = (s) => actionState[s.id] || ["starting", "stopping", "rebuilding"].includes(status(s));

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span>STARBOUND</span>
          <span className={styles.logoDim}>CONTROL</span>
        </div>
        <button className={styles.refreshBtn} onClick={() => fetchServers()} disabled={loading}>
          {loading ? "↻ LADDAR…" : "↻ UPPDATERA"}
        </button>
      </header>

      <main className={styles.main}>
        {error && (
          <div className={styles.errorBanner}>
            ⚠ {error}
          </div>
        )}

        <div className={styles.serverGrid}>
          {loading && servers.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.spinner} />
              <p>Ansluter till Hetzner Cloud…</p>
            </div>
          ) : servers.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyIcon}>◎</p>
              <p>Inga servrar hittades i projektet.</p>
            </div>
          ) : (
            servers.map((server) => (
              <div key={server.id} className={`${styles.card} ${isOn(server) ? styles.cardOn : ""}`}>
                <div className={styles.cardTop}>
                  <div>
                    <div className={styles.serverName}>{server.name}</div>
                    <div className={styles.serverMeta}>
                      {server.server_type?.name} · {server.datacenter?.location?.name?.toUpperCase() || "—"}
                    </div>
                  </div>
                  <div className={styles.statusBadge} style={{ color: STATUS_COLOR[status(server)] }}>
                    <span className={styles.statusDot} style={{ background: STATUS_COLOR[status(server)] }} />
                    {STATUS_LABEL[status(server)] || status(server).toUpperCase()}
                  </div>
                </div>

                <div className={styles.cardStats}>
                  <Stat label="IP" value={server.public_net?.ipv4?.ip || "—"} mono />
                  <Stat label="CPU" value={`${server.server_type?.cores || "—"} vCPU`} />
                  <Stat label="RAM" value={`${server.server_type?.memory || "—"} GB`} />
                  <Stat label="PORT" value="21025" mono />
                </div>

                <div className={styles.cardActions}>
                  {isOn(server) ? (
                    <>
                      <ActionBtn
                        label="STÄNG AV"
                        icon="⏻"
                        color="var(--red)"
                        onClick={() => doAction(server, "shutdown")}
                        disabled={isBusy(server)}
                        loading={actionState[server.id] === "shutdown"}
                      />
                      <ActionBtn
                        label="STARTA OM"
                        icon="↺"
                        color="var(--yellow)"
                        onClick={() => doAction(server, "reboot")}
                        disabled={isBusy(server)}
                        loading={actionState[server.id] === "reboot"}
                      />
                    </>
                  ) : (
                    <ActionBtn
                      label="STARTA"
                      icon="▶"
                      color="var(--green)"
                      onClick={() => doAction(server, "poweron")}
                      disabled={isBusy(server)}
                      loading={actionState[server.id] === "poweron"}
                      wide
                    />
                  )}
                </div>

                {isBusy(server) && (
                  <div className={styles.busyBar}>
                    <div className={styles.busyBarFill} />
                  </div>
                )}
              </div>
            ))
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

function Stat({ label, value, mono }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} style={mono ? { fontFamily: "var(--font-mono)" } : {}}>{value}</span>
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
