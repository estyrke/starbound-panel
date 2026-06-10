import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from "react";
import { getAuthStatus, login, logout } from "../lib/auth.functions.js";
import styles from "../styles/App.module.css";
import type {
  HetznerServer,
  HetznerImage,
  OpState,
  OpPhase,
  Entity,
  LiveEntity,
  DormantEntity,
  PendingEntity,
} from "../lib/types.js";
import {
  sendAction,
  listAllQueryOptions,
  startServerInit,
  stopServerInit,
  snapshotServer,
  deleteServerById,
  getServerStatus,
  getActionStatus,
  updateDnsForServer,
} from "../lib/api.functions.js";
import { runStartFlow, runStopFlow, type StartPhase, type StopPhase } from "../lib/flows.js";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";

const START_LABELS: Record<StartPhase, string> = {
  creating: "Skapar server…",
  "waiting-running": "Väntar på att servern startar…",
  dns: "Uppdaterar DNS…",
};

const STOP_LABELS: Record<StopPhase, string> = {
  "shutting-down": "Stänger av…",
  "waiting-off": "Väntar på avstängning…",
  snapshotting: "Skapar snapshot…",
  deleting: "Raderar server…",
};

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
  stopping: "STOPPAR",
  starting: "STARTAR",
  initializing: "INITIALISERAR",
  rebuilding: "BYGGER OM",
  migrating: "MIGRAERAR",
  deleting: "RADERAR",
};

function formatAge(created: string): string {
  const diff = Math.floor((Date.now() - new Date(created).getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m}m`;
}

function ts(): string {
  return new Date().toLocaleTimeString("sv-SE");
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { authed } = await getAuthStatus();
    return { authed };
  },
  loader: async ({ context }) => {
    if (context.authed) {
      await context.queryClient.ensureQueryData(listAllQueryOptions());
    }
  },
  component: RootComponent,
});

function RootComponent() {
  const { authed } = Route.useRouteContext();
  return authed ? <App /> : <LoginForm />;
}

function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const res = await login({ data: { password } });
      if (res.ok) {
        await router.invalidate();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span>STARBOUND</span>
          <span className={styles.logoDim}>CONTROL</span>
        </div>
      </header>
      <main className={styles.main}>
        <form className={`${styles.card} ${styles.loginCard}`} onSubmit={submit}>
          <div className={styles.serverName}>INLOGGNING</div>
          <input
            className={styles.loginInput}
            type="password"
            placeholder="LÖSENORD"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error && <div className={styles.errorBanner}>⚠ Fel lösenord</div>}
          <div className={styles.cardActions}>
            <ActionBtn
              label={busy ? "LOGGAR IN…" : "LOGGA IN"}
              icon="▶"
              color="var(--green)"
              disabled={busy || password.length === 0}
              wide
            />
          </div>
        </form>
      </main>
    </div>
  );
}

function App() {
  const router = useRouter();
  const { data, isLoading, error } = useSuspenseQuery(listAllQueryOptions());
  const servers = data?.servers ?? [];
  const dormantServers = data?.dormant ?? [];

  const queryClient = useQueryClient();
  // opState: tracks in-progress multi-step operations so cards can show live status
  const [opState, setOpState] = useState<Record<string, OpState>>({});
  const [log, setLog] = useState<string[]>(() => [`[${ts()}] Panel ansluten – hämtar servrar…`]);

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [`[${ts()}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  const setOp = (name: string, phase: OpPhase, label: string) =>
    setOpState((s) => ({ ...s, [name]: { phase, label } }));
  const clearOp = (name: string) =>
    setOpState((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });

  // Full stop flow: graceful shutdown → snapshot → delete, driven step by step
  // from the client so no single request runs for minutes
  const doStop = useCallback(
    async (server: HetznerServer) => {
      const { name, id } = server;
      addLog(`Sparar och stänger av ${name}…`);
      try {
        await runStopFlow(
          { stopServerInit, getServerStatus, snapshotServer, getActionStatus, deleteServerById },
          { serverId: id },
          (phase) => setOp(name, phase, STOP_LABELS[phase])
        );

        addLog(`✓ ${name} sparad och stängd`);
        queryClient.invalidateQueries({ queryKey: ["list-all"] });
      } catch (e) {
        addLog(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        clearOp(name);
      }
    },
    [addLog, queryClient]
  );

  // Full start flow: server resolves snapshot automatically, falls back to fresh install
  const doStart = useCallback(
    async ({ name, serverType, location }: { name: string; serverType?: string; location?: string }) => {
      addLog(`Startar ${name}…`);
      try {
        const res = await runStartFlow(
          { startServerInit, getServerStatus, updateDnsForServer },
          { name, serverType, location },
          (phase) => setOp(name, phase, START_LABELS[phase])
        );

        if (res.dnsRecord) {
          addLog(`✓ DNS uppdaterad: ${res.dnsRecord.record} A→${res.dnsRecord.ip} AAAA→${res.dnsRecord.ipv6}`);
        }
        if (res.dnsError) {
          addLog(`⚠ DNS-uppdatering misslyckades: ${res.dnsError}`);
        }

        addLog(`✓ ${name} online`);
        queryClient.invalidateQueries({ queryKey: ["list-all"] });
      } catch (e) {
        addLog(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        clearOp(name);
      }
    },
    [addLog, queryClient]
  );

  // Simple single-step actions (reboot, poweron for manually-stopped servers)
  const doAction = useCallback(
    async (server: HetznerServer, action: "reboot" | "poweron") => {
      const label = action === "reboot" ? "Startar om" : "Startar";
      setOp(server.name, action, `${label}…`);
      addLog(`${label} ${server.name}…`);
      try {
        await sendAction({ data: { id: server.id, action } });
        addLog(`✓ ${label} ${server.name} – åtgärd startad`);
      } catch (e) {
        addLog(`✗ Fel: ${(e as Error).message}`);
      } finally {
        clearOp(server.name);
      }
    },
    [addLog]
  );

  // Build entity list from server-side merged data + client-side pending state
  const entities = useMemo<Entity[]>(() => {
    const liveNames = new Set(servers.map((s) => s.name));

    const result: Entity[] = [
      ...servers.map((server) => ({
        type: "live" as const,
        key: `live-${server.id}`,
        server,
        snapshot: null,
        name: server.name,
      })),
      ...dormantServers
        .filter(({ name }) => !opState[name])
        .map(({ name, snapshot, serverType, location }) => ({
          type: "dormant" as const,
          key: `dormant-${snapshot.id}`,
          snapshot,
          name,
          serverType,
          location,
        })),
    ];

    for (const [name, op] of Object.entries(opState)) {
      if (!liveNames.has(name)) {
        result.push({ type: "pending", key: `pending-${name}`, name, op });
      }
    }

    return result;
  }, [servers, dormantServers, opState]);

  const showFresh = !isLoading && entities.length === 0;

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span>STARBOUND</span>
          <span className={styles.logoDim}>CONTROL</span>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.refreshBtn}
            onClick={() => queryClient.refetchQueries()}
            disabled={isLoading}
          >
            {isLoading ? "↻ LADDAR…" : "↻ UPPDATERA"}
          </button>
          <button
            className={styles.refreshBtn}
            onClick={async () => {
              await logout();
              await router.invalidate();
            }}
          >
            ⏏ LOGGA UT
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {error && <div className={styles.errorBanner}>⚠ {error.message}</div>}

        <div className={styles.serverGrid}>
          {isLoading && entities.length === 0 ? (
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
              log.map((entry) => (
                <div key={entry} className={styles.logEntry}>
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
        <Stat
          label="SNAPSHOT"
          value={formatAge(snapshot.created)}
          title={`Snapshot ID: ${snapshot.id}`}
        />
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
  title?: string;
}

function Stat({ label, value, mono, title }: StatProps) {
  return (
    <div className={styles.stat} title={title}>
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
