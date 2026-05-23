import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { HetznerAction, HetznerImage, HetznerServer } from "./types";

const HETZNER_API = "https://api.hetzner.cloud/v1";

type Action = "poweron" | "poweroff" | "reboot" | "shutdown";

export const sendAction = createServerFn({ method: "POST" })
  .inputValidator((data: { id: number; action: Action }) => data)
  .handler(async ({ data }) => {
    const { id, action } = data;

    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    try {
      const r = await fetch(`${HETZNER_API}/servers/${id}/actions/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const data = await r.json();
      return data;
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  });

export const listServers = createServerFn().handler(
  async (): Promise<{ servers: HetznerServer[] }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    try {
      const r = await fetch(`${HETZNER_API}/servers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      return data;
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  }
);

export const serversQueryOptions = () =>
  queryOptions({
    queryKey: ["servers"],
    queryFn: async () => (await listServers()).servers,
  });

export const listSnapshots = createServerFn().handler(
  async (): Promise<{ images: HetznerImage[] }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    try {
      // Only fetch snapshots created by this panel (label managed=starbound-panel)
      const r = await fetch(
        `${HETZNER_API}/images?type=snapshot&label_selector=managed%3Dstarbound-panel&sort=created:desc`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await r.json();
      return data;
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  }
);

export const snapshotsQueryOptions = () =>
  queryOptions({
    queryKey: ["snapshots"],
    queryFn: async () => (await listSnapshots()).images,
  });

export const getAction = createServerFn()
  .inputValidator((data: { id: number }) => data)
  .handler(async ({ data }): Promise<{ action: HetznerAction }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    const { id } = data;

    try {
      const r = await fetch(`${HETZNER_API}/actions/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      return data;
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  });

export const actionQueryOptions = (id: number) =>
  queryOptions({
    queryKey: ["action", id],
    queryFn: () => getAction({ data: { id } }),
  });

// Finds an existing managed firewall or creates one with SSH + Starbound ports open.
async function ensureFirewall(token: string): Promise<number> {
  const listRes = await fetch(`${HETZNER_API}/firewalls?name=starbound-panel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json();
  if (listData.firewalls?.length > 0) return listData.firewalls[0].id as number;

  const createRes = await fetch(`${HETZNER_API}/firewalls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "starbound-panel",
      rules: [
        { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "21025", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "udp", port: "21025", source_ips: ["0.0.0.0/0", "::/0"] },
      ],
    }),
  });
  const createData = await createRes.json();
  return createData.firewall.id as number;
}

// Cloud-init script for a fresh Starbound install via SteamCMD.
// Requires STEAM_USER and STEAM_PASS env vars. Steam Guard must be disabled
// or pre-authorised on the account used.
function buildCloudInit(steamUser: string, steamPass: string): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
dpkg --add-architecture i386
echo steam steam/question select "I AGREE" | sudo debconf-set-selections
echo steam steam/license note '' | sudo debconf-set-selections
apt-get update -y
apt-get install -y lib32gcc-s1 libsdl2-2.0-0 steamcmd
useradd -m -s /bin/bash steam 2>/dev/null || true
su - steam -c '/usr/games/steamcmd +login ${steamUser} ${steamPass} +force_install_dir /home/steam/starbound +app_update 211820 validate +quit'
cat > /etc/systemd/system/starbound.service << 'SERVICE'
[Unit]
Description=Starbound Dedicated Server
After=network.target

[Service]
User=steam
WorkingDirectory=/home/steam/starbound/linux
ExecStart=/home/steam/starbound/linux/starbound_server
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable starbound
systemctl start starbound
`;
}

interface CreateServerBody {
  snapshotId?: number;
  name?: string;
  serverType?: string;
  location?: string;
}

export const createServer = createServerFn({ method: "POST" })
  .inputValidator((data: CreateServerBody) => {
    if (!data.snapshotId && (!process.env.STEAM_USER || !process.env.STEAM_PASS)) {
      throw new Error(
        "STEAM_USER and STEAM_PASS env vars are required for a fresh install (no snapshot found)"
      );
    }
    return data;
  })
  .handler(async ({ data }) => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    const { snapshotId, name, serverType, location } = data;

    try {
      // Include all SSH keys registered in the project so the server is accessible
      const keysRes = await fetch(`${HETZNER_API}/ssh_keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const keysData = keysRes.ok ? await keysRes.json() : { ssh_keys: [] };
      const sshKeys = (keysData.ssh_keys as { id: number }[]).map((k) => k.id);

      const resolvedName = name ?? process.env.SERVER_NAME ?? "starbound";
      const resolvedType = serverType ?? process.env.HETZNER_SERVER_TYPE ?? "cx23";
      const resolvedLocation = location ?? process.env.HETZNER_LOCATION ?? "hel1";

      const firewallId = await ensureFirewall(token);

      const body: Record<string, unknown> = {
        name: resolvedName,
        server_type: resolvedType,
        location: resolvedLocation,
        ssh_keys: sshKeys,
        firewalls: [{ firewall: firewallId }],
        labels: { managed: "starbound-panel" },
      };

      if (snapshotId) {
        body.image = snapshotId;
      } else {
        const steamUser = process.env.STEAM_USER;
        const steamPass = process.env.STEAM_PASS;
        if (!steamUser || !steamPass) {
          throw new Error(
            "STEAM_USER and STEAM_PASS env vars are required for a fresh install (no snapshot found)"
          );
        }
        body.image = "ubuntu-22.04";
        body.user_data = buildCloudInit(steamUser, steamPass);
      }

      const r = await fetch(`${HETZNER_API}/servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return data;
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  });

export const deleteServer = createServerFn({ method: "POST" })
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ success: true }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    const { serverId } = data;

    try {
      const r = await fetch(`${HETZNER_API}/servers/${serverId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 200 || r.status === 204) return { success: true };
      const data = await r.json();
      throw new Error(data.error || "Failed to delete server");
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  });

export const takeSnapshot = createServerFn({ method: "POST" })
  .inputValidator((data: { serverId: number }) => data)
  .handler(async ({ data }): Promise<{ action: HetznerAction }> => {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");

    const { serverId } = data;

    try {
      // Fetch server details so we can store config in snapshot labels for later recreation
      const serverRes = await fetch(`${HETZNER_API}/servers/${serverId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!serverRes.ok) throw new Error(`Failed to fetch server: HTTP ${serverRes.status}`);
      const { server } = await serverRes.json();

      const r = await fetch(`${HETZNER_API}/servers/${serverId}/actions/create_image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "snapshot",
          description: `starbound:${server.name}`,
          labels: {
            managed: "starbound-panel",
            "server-name": server.name,
            "server-type": server.server_type.name,
            location: server.datacenter.location.name,
          },
        }),
      });
      const data = await r.json();
      return data;
    } catch (e) {
      throw new Error((e as Error).message, { cause: e });
    }
  });
