import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from "react";
import styles from "../styles/App.module.css";
import type {
  HetznerServer,
  HetznerImage,
  OpState,
  StartParams,
  Entity,
  LiveEntity,
  DormantEntity,
  PendingEntity,
} from "../lib/types.js";
import {
  sendAction,
  createServer,
  deleteServer,
  takeSnapshot,
  serversQueryOptions,
  snapshotsQueryOptions,
  actionQueryOptions,
} from "../lib/hetzner.functions.js";
import { updateDns } from "../lib/gandi.functions.js";
import { QueryObserver, useSuspenseQueries, useQueryClient } from "@tanstack/react-query";

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

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(serversQueryOptions()),
      context.queryClient.ensureQueryData(snapshotsQueryOptions()),
    ]);
  },
  component: App,
});

function App() {
  const { servers, snapshots, isLoading, error } = useSuspenseQueries({
    queries: [serversQueryOptions(), snapshotsQueryOptions()],
    combine: ([serverData, snapshotData]) => ({
      servers: serverData.data,
      snapshots: snapshotData.data,
      isLoading: serverData.isLoading || snapshotData.isLoading,
      error: serverData.error ?? snapshotData.error,
    }),
  });

  const queryClient = useQueryClient();
  // opState: tracks in-progress multi-step operations so cards can show live status
  const [opState, setOpState] = useState<Record<string, OpState>>({});
  const [log, setLog] = useState<string[]>(() => [`[${ts()}] Panel ansluten – hämtar servrar…`]);

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [`[${ts()}] ${msg}`, ...prev].slice(0, 50));
  }, []);

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
        const servers = await queryClient.fetchQuery(serversQueryOptions());
        const found = servers.find((s) => s.id === serverId) ?? null;
        if (targetStatus === null && !found) return null;
        if (found?.status === targetStatus) return found;
      }
      throw new Error("Timeout: servern svarar inte");
    },
    [queryClient]
  );

  // Polls a Hetzner action until it succeeds or errors
  const waitForAction = useCallback(
    async (actionId: number): Promise<void> => {
      const observer = new QueryObserver(queryClient, {
        ...actionQueryOptions(actionId),
        refetchInterval: 4000,
        refetchOnWindowFocus: false,
      });

      return new Promise<void>((resolve, reject) => {
        const unsubscribe = observer.subscribe((result) => {
          if (result.isError) {
            unsubscribe();
            reject(result.error as Error);
            return;
          }

          const action = result.data?.action;
          if (action?.status === "success") {
            unsubscribe();
            resolve();
            return;
          }

          if (action?.status === "error") {
            unsubscribe();
            reject(new Error(action.error?.message ?? "Åtgärden misslyckades"));
          }
        });

        observer.fetchOptimistic(actionQueryOptions(actionId)).catch((err) => {
          unsubscribe();
          reject(err as Error);
        });
      });
    },
    [queryClient]
  );

  // Full stop flow: graceful shutdown → snapshot → delete
  const doStop = useCallback(
    async (server: HetznerServer) => {
      const { name, id } = server;
      addLog(`Sparar och stänger av ${name}…`);
      try {
        setOp(name, "stopping", "Stänger av…");

        await sendAction({
          data: {
            id,
            action: "shutdown",
          },
        });

        await waitForServerStatus(id, "off");

        setOp(name, "snapshotting", "Skapar snapshot…");
        addLog(`${name}: av – skapar snapshot`);
        const snapData = await takeSnapshot({ data: { serverId: id } });

        await waitForAction(snapData.action.id);
        queryClient.invalidateQueries({ queryKey: ["snapshots"] });

        setOp(name, "deleting", "Raderar server…");
        addLog(`${name}: snapshot klar – raderar server`);
        const delRes = await deleteServer({ data: { serverId: id } });
        if (!delRes.success) throw new Error("Misslyckades med att radera servern");
        addLog(`✓ ${name} sparad och stängd`);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      } catch (e) {
        addLog(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        clearOp(name);
      }
    },
    [addLog, waitForServerStatus, waitForAction, queryClient]
  );

  // Full start flow: create server from snapshot (or cloud-init for first launch)
  const doStart = useCallback(
    async ({ name, serverType, location, snapshotId }: StartParams) => {
      addLog(
        snapshotId
          ? `Startar ${name} från snapshot…`
          : `Startar ${name} – installerar från grunden…`
      );
      try {
        setOp(name, "creating", "Skapar server…");
        const data = await createServer({ data: { snapshotId, name, serverType, location } });
        const newId = data.server.id;

        setOp(name, "booting", "Väntar på start…");
        addLog(`${name}: server skapad – väntar på start`);
        let liveServer: HetznerServer | null = null;
        if (newId) liveServer = await waitForServerStatus(newId, "running");

        const ip = liveServer?.public_net.ipv4?.ip;
        // Hetzner gives IPv6 as a network (e.g. "2a01:4f8::/64"); the server sits at ::1
        const ipv6Network = liveServer?.public_net.ipv6?.ip;
        const ipv6 = ipv6Network ? ipv6Network.split("/")[0].replace(/::$/, "::1") : null;

        if (ip && ipv6) {
          setOp(name, "dns", "Uppdaterar DNS…");
          addLog(`${name}: online (${ip ?? ipv6}) – uppdaterar DNS`);
          try {
            const dnsData = await updateDns({ data: { ip, ipv6 } });
            addLog(
              `✓ DNS uppdaterad: ${(dnsData as { record: string }).record} A→${ip} AAAA→${ipv6}`
            );
          } catch (e) {
            addLog(`✗ DNS misslyckades: ${(e as Error).message}`);
          }
        }

        addLog(`✓ ${name} online`);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      } catch (e) {
        addLog(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        clearOp(name);
      }
    },
    [addLog, queryClient, waitForServerStatus]
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
      if (!liveByName[name]) {
        result.push({ type: "pending", key: `pending-${name}`, name, op });
      }
    }

    return result;
  }, [servers, snapshots, opState]);

  const showFresh = !isLoading && entities.length === 0;

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span>STARBOUND</span>
          <span className={styles.logoDim}>CONTROL</span>
        </div>
        <button
          className={styles.refreshBtn}
          onClick={() => queryClient.refetchQueries()}
          disabled={isLoading}
        >
          {isLoading ? "↻ LADDAR…" : "↻ UPPDATERA"}
        </button>
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
