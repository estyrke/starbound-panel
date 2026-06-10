import configureClient, { CreateServerRequest } from "@small-tech/hetzner-cloud-openapi-client";
import { selectSnapshotsToDelete } from "./helpers";

const HETZNER_API = "https://api.hetzner.cloud/v1/";

let apiPromise: ReturnType<typeof configureClient> | null = null;

// Lazily configured so the token is read at request time, not at import/build time.
function getApi() {
  if (!apiPromise) {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN not configured");
    // The package's declared options only accept `headers`, but its wrapper
    // forwards only `getHeaders` to massimo — a plain `headers` option is
    // silently dropped, so we must pass getHeaders despite the types.
    apiPromise = configureClient({
      url: HETZNER_API,
      getHeaders: async () => ({ Authorization: `Bearer ${token}` }),
    } as Parameters<typeof configureClient>[0]);
  }
  return apiPromise;
}

export const listServers = async () => {
  try {
    const api = await getApi();
    const res = await api.listServers({});
    if (res.statusCode !== 200) {
      throw new Error(`Failed to list servers: HTTP ${res.statusCode}`);
    }
    return res.body["servers"];
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const listSnapshots = async () => {
  try {
    const api = await getApi();
    const res = await api.listImages({ query: { type: ["snapshot"] } });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to list snapshots: HTTP ${res.statusCode}`);
    }
    return res.body["images"];
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

type Action = "poweron" | "poweroff" | "reboot" | "shutdown";

export const sendAction = async ({ action, id }: { action: Action; id: number }) => {
  try {
    const api = await getApi();
    switch (action) {
      case "poweron":
        return await api.poweronServer({ path: { id } });
      case "poweroff":
        return await api.poweroffServer({ path: { id } });
      case "reboot":
        return await api.rebootServer({ path: { id } });
      case "shutdown":
        return await api.shutdownServer({ path: { id } });
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const getAction = async (id: number) => {
  try {
    const api = await getApi();
    const res = await api.getAction({ path: { id } });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to fetch action: HTTP ${res.statusCode}`);
    }
    return res.body.action;
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

// Finds an existing managed firewall or creates one with SSH + Starbound ports open.
async function ensureFirewall(): Promise<number> {
  const api = await getApi();
  const listRes = await api.listFirewalls({ query: { name: "starbound-panel" } });
  if (listRes.statusCode !== 200) {
    throw new Error(`Failed to list firewalls: HTTP ${listRes.statusCode}`);
  }
  const listData = listRes.body;
  if (listData.firewalls.length > 0) return listData.firewalls[0].id as number;

  const createRes = await api.createFirewall({
    body: {
      name: "starbound-panel",
      rules: [
        { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "21025", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "udp", port: "21025", source_ips: ["0.0.0.0/0", "::/0"] },
      ],
    },
  });
  if (createRes.statusCode !== 201) {
    throw new Error(`Failed to create firewall: HTTP ${createRes.statusCode}`);
  }
  const createData = createRes.body;

  if (!createData.firewall?.id) {
    console.log("Unexpected firewall creation response:", createData);
    throw new Error("Failed to create firewall: no firewall ID in response");
  }
  return createData.firewall.id;
}

// Quote a string as a single shell word (safe for spaces and special characters).
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Cloud-init script for a fresh Starbound install via SteamCMD.
// Requires STEAM_USER and STEAM_PASS env vars. Steam Guard must be disabled
// or pre-authorised on the account used.
function buildCloudInit(steamUser: string, steamPass: string): string {
  const steamcmd = `/usr/games/steamcmd +login ${shellQuote(steamUser)} ${shellQuote(steamPass)} +force_install_dir /home/steam/starbound +app_update 211820 validate +quit`;
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
su - steam -c ${shellQuote(steamcmd)}
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

export const createServer = async ({
  snapshotId,
  name,
  serverType,
  location,
}: CreateServerBody) => {
  try {
    const api = await getApi();
    // Include all SSH keys registered in the project so the server is accessible
    const keysRes = await api.listSshKeys({});
    const sshKeys =
      keysRes.statusCode === 200 ? keysRes.body.ssh_keys.map((k) => k.id.toString()) : [];

    const resolvedName = name ?? process.env.SERVER_NAME ?? "starbound";
    const resolvedType = serverType ?? process.env.HETZNER_SERVER_TYPE ?? "cx23";
    const resolvedLocation = location ?? process.env.HETZNER_LOCATION ?? "hel1";

    const firewallId = await ensureFirewall();

    const body: CreateServerRequest["body"] = {
      name: resolvedName,
      image: snapshotId ? snapshotId.toString() : "ubuntu-22.04",
      server_type: resolvedType,
      location: resolvedLocation,
      ssh_keys: sshKeys,
      firewalls: [{ firewall: firewallId }],
      labels: { managed: "starbound-panel" },
    };

    if (!snapshotId) {
      const steamUser = process.env.STEAM_USER;
      const steamPass = process.env.STEAM_PASS;
      if (!steamUser || !steamPass) {
        throw new Error(
          "STEAM_USER and STEAM_PASS env vars are required for a fresh install (no snapshot found)"
        );
      }
      body.user_data = buildCloudInit(steamUser, steamPass);
    }

    const r = await api.createServer({ body });
    if (r.statusCode !== 201) {
      console.log("Unexpected create server response:", r.body);
      throw new Error(r.body.error.message || `Failed to create server: HTTP ${r.statusCode}`);
    }
    const data = r.body;
    return data;
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const deleteServer = async (serverId: number): Promise<{ success: true }> => {
  try {
    const api = await getApi();
    const r = await api.deleteServer({ path: { id: serverId } });

    if (r.statusCode === 200) return { success: true };
    const data = r.body;
    console.log("Unexpected delete server response:", data);
    throw new Error(data.error.message || "Failed to delete server");
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const getServer = async (serverId: number) => {
  try {
    const api = await getApi();
    const r = await api.getServer({ path: { id: serverId } });
    if (r.statusCode !== 200) {
      throw new Error(`Failed to fetch server: HTTP ${r.statusCode}`);
    }
    const data = r.body;
    return data.server;
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const takeSnapshot = async (serverId: number) => {
  try {
    const api = await getApi();
    // Fetch server details so we can store config in snapshot labels for later recreation
    const serverRes = await api.getServer({ path: { id: serverId } });
    if (serverRes.statusCode !== 200)
      throw new Error(`Failed to fetch server: HTTP ${serverRes.statusCode}`);
    const { server } = serverRes.body;
    if (!server) throw new Error("Failed to fetch server: no server data in response");

    const r = await api.createServerImage({
      path: { id: serverId },
      body: {
        type: "snapshot",
        description: `starbound:${server.name}`,
        labels: {
          managed: "starbound-panel",
          "server-name": server.name,
          "server-type": server.server_type.name,
          location: server.datacenter.location.name,
        },
      },
    });
    if (r.statusCode !== 201) {
      console.log("Unexpected create snapshot response:", r.body);
      throw new Error(r.body.error.message || `Failed to create snapshot: HTTP ${r.statusCode}`);
    }
    const data = r.body;

    // Trigger cleanup of old snapshots after successful creation
    await cleanupOldSnapshots(server.name);

    return data;
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const getLatestSnapshot = async (serverName: string) => {
  try {
    const api = await getApi();
    const r = await api.listImages({
      query: {
        type: ["snapshot"],
        label_selector: `managed=starbound-panel,server-name=${encodeURIComponent(serverName)}`,
        sort: ["created:desc"],
        per_page: 1,
      },
    });
    if (r.statusCode !== 200) throw new Error(`Failed to list snapshots: HTTP ${r.statusCode}`);
    const { images } = r.body;
    if (images.length === 0) return null;
    return images[0];
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};

export const cleanupOldSnapshots = async (
  serverName: string
): Promise<{ deletedCount: number; remaining: number; policy: string }> => {
  const parsed = parseInt(process.env.SNAPSHOT_RETENTION_COUNT ?? "2", 10);
  // Guard against a misconfigured env var: slice(NaN) would select everything
  const retentionCount = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;

  try {
    const api = await getApi();
    // Query all snapshots for this server, sorted by created date (newest first)
    const r = await api.listImages({
      query: {
        type: ["snapshot"],
        label_selector: `managed=starbound-panel,server-name=${encodeURIComponent(serverName)}`,
        sort: ["created:desc"],
      },
    });
    if (r.statusCode !== 200) throw new Error(`Failed to fetch snapshots: HTTP ${r.statusCode}`);

    const { images } = r.body;
    const snapshotIds = images.map((img) => img.id);

    const toDelete = selectSnapshotsToDelete(snapshotIds, retentionCount);
    if (toDelete.length === 0) {
      return {
        deletedCount: 0,
        remaining: snapshotIds.length,
        policy: `keep_last_${retentionCount}`,
      };
    }
    await Promise.all(
      toDelete.map((id) =>
        api.deleteImage({ path: { id } }).then((res) => {
          if (res.statusCode !== 204) {
            console.log(`Failed to delete snapshot ${id}:`, res.body);
            throw new Error(`Failed to delete snapshot ${id}: HTTP ${res.statusCode}`);
          }
          console.log(`Deleted old snapshot ${id} for server ${serverName}`);
        })
      )
    );

    return {
      deletedCount: toDelete.length,
      remaining: retentionCount,
      policy: `keep_last_${retentionCount}`,
    };
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};
