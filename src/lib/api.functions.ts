import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./auth.middleware";
import { updateDns } from "./gandi.server";
import { buildDormantList, deriveIpv6Host } from "./helpers";
import {
  createServer,
  deleteServer,
  getAction,
  getLatestSnapshot,
  getServer,
  sendAction as hetznerSendAction,
  listServers,
  listSnapshots,
  takeSnapshot,
} from "./hetzner.server";
import { DormantServer, HetznerServer } from "./types";

export const listAll = createServerFn()
  .middleware([authMiddleware])
  .handler(async (): Promise<{ servers: HetznerServer[]; dormant: DormantServer[] }> => {
    try {
      const [servers, snapshots] = await Promise.all([listServers(), listSnapshots()]);
      return { servers, dormant: buildDormantList(servers, snapshots) };
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  });

export const listAllQueryOptions = () =>
  queryOptions({
    queryKey: ["list-all"],
    queryFn: () => listAll(),
    refetchInterval: 10_000,
  });

// ── Short single-round-trip server functions. The client orchestrates the
// multi-step start/stop flows (see flows.ts) so no request blocks for minutes.

export const startServerInit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { name: string; serverType?: string; location?: string }) => data)
  .handler(async ({ data }): Promise<{ serverId: number }> => {
    const snapshot = await getLatestSnapshot(data.name);
    const createRes = await createServer({
      name: data.name,
      snapshotId: snapshot?.id,
      serverType: data.serverType,
      location: data.location,
    });
    if (!createRes.server) throw new Error("Failed to create server: no server data");
    return { serverId: createRes.server.id };
  });

export const stopServerInit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ success: true }> => {
    await hetznerSendAction({ id: data.serverId, action: "shutdown" });
    return { success: true };
  });

export const snapshotServer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ actionId: number; imageId?: number }> => {
    const res = await takeSnapshot(data.serverId);
    if (!res.action) throw new Error("Snapshot creation returned no action");
    return { actionId: res.action.id, imageId: res.image?.id };
  });

export const deleteServerById = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ success: true }> => {
    return deleteServer(data.serverId);
  });

export const getServerStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ status: string } | null> => {
    try {
      const server = await getServer(data.serverId);
      return server ? { status: server.status } : null;
    } catch (e) {
      // A deleted server is a normal terminal state for the stop flow
      if ((e as Error).message.includes("404")) return null;
      throw e;
    }
  });

export const getActionStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { actionId: number }) => data)
  .handler(async ({ data }): Promise<{ status: string; errorMessage?: string }> => {
    const action = await getAction(data.actionId);
    return { status: action.status, errorMessage: action.error?.message };
  });

export const updateDnsForServer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ record: string; ip: string; ipv6: string } | null> => {
    const server = await getServer(data.serverId);
    const ip = server?.public_net.ipv4?.ip;
    const ipv6 = deriveIpv6Host(server?.public_net.ipv6?.ip);
    if (!ip || !ipv6) return null;
    const res = await updateDns({ ip, ipv6 });
    return { record: res.record, ip: res.ip, ipv6: res.ipv6 };
  });

export const sendAction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { id: number; action: "reboot" | "poweron" }) => data)
  .handler(async ({ data }) => {
    await hetznerSendAction(data);
    return { success: true };
  });
