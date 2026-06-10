import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./auth.middleware";
import { updateDns } from "./gandi.server";
import {
  createServer,
  deleteServer,
  getAction,
  getLatestSnapshot,
  getServer,
  listServers,
  listSnapshots,
  sendAction as hetznerSendAction,
  takeSnapshot,
} from "./hetzner.server";
import { HetznerImage, HetznerServer } from "./types";

type DormantServer = {
  name: string;
  snapshot: HetznerImage;
  serverType?: string;
  location?: string;
};

export const listAll = createServerFn().middleware([authMiddleware]).handler(
  async (): Promise<{ servers: HetznerServer[]; dormant: DormantServer[] }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    try {
      const [servers, snapshots] = await Promise.all([listServers(), listSnapshots()]);

      const liveNames = new Set<string>(servers.map((s) => s.name));

      const latestSnap: Record<string, HetznerImage> = {};
      for (const snap of snapshots) {
        const name =
          snap.labels["server-name"] ?? snap.description.replace("starbound:", "") ?? "unknown";
        if (!latestSnap[name] || new Date(snap.created) > new Date(latestSnap[name].created)) {
          latestSnap[name] = snap;
        }
      }

      const dormant: DormantServer[] = Object.entries(latestSnap)
        .filter(([name]) => !liveNames.has(name))
        .map(([name, snap]) => ({
          name,
          snapshot: snap,
          serverType: snap.labels["server-type"],
          location: snap.labels["location"],
        }));

      return { servers, dormant };
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  }
);

export const listAllQueryOptions = () =>
  queryOptions({
    queryKey: ["list-all"],
    queryFn: () => listAll(),
  });

interface StartServerOptions {
  serverType?: string;
  location?: string;
}

export const startServer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { name: string; options?: StartServerOptions }) => data)
  .handler(
    async ({
      data,
    }): Promise<{
      server?: HetznerServer;
      dnsRecord?: { record: string; ip: string; ipv6: string };
      success: boolean;
      error?: string;
    }> => {
      const token = process.env.HETZNER_API_TOKEN;
      if (!token) throw new Error("HETZNER_API_TOKEN not configured");

      const { name, options = {} } = data;

      try {
        // Find latest snapshot for this server name
        const snapRes = await getLatestSnapshot(name);
        const snapshotId = snapRes?.id;

        // Step 1: Create server
        const createRes = await createServer({
          name,
          snapshotId,
          serverType: options.serverType,
          location: options.location,
        });

        if (!createRes.server) throw new Error("Failed to create server: no server data");

        const serverId = createRes.server.id;
        let liveServer: HetznerServer | null = null;

        // Step 2: Wait for running (poll up to 90 times, 4s apart)
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          const found = await getServer(serverId);
          if (found?.status === "running") {
            liveServer = found;
            break;
          }
        }

        if (!liveServer) throw new Error("Server failed to start (timeout)");

        const ip = liveServer.public_net.ipv4?.ip;
        const ipv6Network = liveServer.public_net.ipv6?.ip;
        const ipv6 = ipv6Network ? ipv6Network.split("/")[0].replace(/::$/, "::1") : null;

        let dnsRecord: { record: string; ip: string; ipv6: string } | undefined;

        // Step 3: Update DNS if IPs available
        if (ip && ipv6) {
          try {
            const dnsRes = await updateDns({ ip, ipv6 });
            dnsRecord = dnsRes as { record: string; ip: string; ipv6: string };
          } catch (e) {
            // DNS failure is not fatal, log and continue
            console.error("DNS update failed:", (e as Error).message);
          }
        }

        return { server: liveServer, dnsRecord, success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }
  );

export const stopServer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ success: boolean; snapshotId?: number; error?: string }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    const { serverId } = data;

    try {
      // Step 1: Shutdown
      await hetznerSendAction({ id: serverId, action: "shutdown" });

      // Step 2: Wait for off (poll up to 90 times, 4s apart)
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const found = await getServer(serverId);
        if (!found || found.status === "off") break;
      }

      // Step 3: Snapshot (which auto-cleans old snapshots)
      const snapRes = await takeSnapshot(serverId);
      if (!snapRes.action) throw new Error("Snapshot creation returned no action");
      const snapshotActionId = snapRes.action.id;

      // Step 4: Wait for snapshot action to complete
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const action = await getAction(snapshotActionId);
        if (action.status === "success") break;
        if (action.status === "error") throw new Error(action.error?.message ?? "Snapshot failed");
      }

      // Step 5: Delete server
      await deleteServer(serverId);

      return { success: true, snapshotId: snapRes.image?.id };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

export const sendAction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { id: number; action: "reboot" | "poweron" }) => data)
  .handler(async ({ data }) => {
    await hetznerSendAction(data);
    return { success: true };
  });
