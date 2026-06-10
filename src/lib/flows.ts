// Client-side orchestration of the multi-step start/stop flows. Each step is
// a short server-function round trip, so no single HTTP request has to outlive
// a serverless function timeout. Dependencies are injected for testability.

export type StartPhase = "creating" | "waiting-running" | "dns";
export type StopPhase = "shutting-down" | "waiting-off" | "snapshotting" | "deleting";

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  { intervalMs = 4000, timeoutMs = 360_000 }: PollOptions = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error("Operation timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface ServerStatus {
  status: string;
}

export interface StartFlowDeps {
  startServerInit: (args: {
    data: { name: string; serverType?: string; location?: string };
  }) => Promise<{ serverId: number }>;
  getServerStatus: (args: { data: { serverId: number } }) => Promise<ServerStatus | null>;
  updateDnsForServer: (args: {
    data: { serverId: number };
  }) => Promise<{ record: string; ip: string; ipv6: string } | null>;
}

export interface StartFlowResult {
  serverId: number;
  dnsRecord: { record: string; ip: string; ipv6: string } | null;
  dnsError?: string;
}

export async function runStartFlow(
  deps: StartFlowDeps,
  params: { name: string; serverType?: string; location?: string },
  onPhase: (phase: StartPhase) => void,
  pollOptions?: PollOptions
): Promise<StartFlowResult> {
  onPhase("creating");
  const { serverId } = await deps.startServerInit({ data: params });

  onPhase("waiting-running");
  await pollUntil(
    () => deps.getServerStatus({ data: { serverId } }),
    (s) => s?.status === "running",
    pollOptions
  );

  onPhase("dns");
  let dnsRecord: StartFlowResult["dnsRecord"] = null;
  let dnsError: string | undefined;
  try {
    dnsRecord = await deps.updateDnsForServer({ data: { serverId } });
  } catch (e) {
    // DNS failure is not fatal — the server is up either way
    dnsError = (e as Error).message;
  }

  return { serverId, dnsRecord, dnsError };
}

export interface StopFlowDeps {
  stopServerInit: (args: { data: { serverId: number } }) => Promise<{ success: true }>;
  getServerStatus: (args: { data: { serverId: number } }) => Promise<ServerStatus | null>;
  snapshotServer: (args: {
    data: { serverId: number };
  }) => Promise<{ actionId: number; imageId?: number }>;
  getActionStatus: (args: {
    data: { actionId: number };
  }) => Promise<{ status: string; errorMessage?: string }>;
  deleteServerById: (args: { data: { serverId: number } }) => Promise<{ success: true }>;
}

export async function runStopFlow(
  deps: StopFlowDeps,
  { serverId }: { serverId: number },
  onPhase: (phase: StopPhase) => void,
  pollOptions?: PollOptions
): Promise<{ imageId?: number }> {
  onPhase("shutting-down");
  await deps.stopServerInit({ data: { serverId } });

  onPhase("waiting-off");
  await pollUntil(
    () => deps.getServerStatus({ data: { serverId } }),
    (s) => !s || s.status === "off",
    pollOptions
  );

  onPhase("snapshotting");
  const { actionId, imageId } = await deps.snapshotServer({ data: { serverId } });
  const action = await pollUntil(
    () => deps.getActionStatus({ data: { actionId } }),
    (a) => a.status !== "running",
    pollOptions
  );
  if (action.status === "error") {
    throw new Error(action.errorMessage ?? "Snapshot failed");
  }

  onPhase("deleting");
  await deps.deleteServerById({ data: { serverId } });

  return { imageId };
}
