const HETZNER_API = "https://api.hetzner.cloud/v1";

// Finds an existing managed firewall or creates one with SSH + Starbound ports open.
async function ensureFirewall(token) {
  const listRes = await fetch(`${HETZNER_API}/firewalls?name=starbound-panel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json();
  if (listData.firewalls?.length > 0) return listData.firewalls[0].id;

  const createRes = await fetch(`${HETZNER_API}/firewalls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "starbound-panel",
      rules: [
        { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "22",    source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "21025", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "udp", port: "21025", source_ips: ["0.0.0.0/0", "::/0"] },
      ],
    }),
  });
  const createData = await createRes.json();
  return createData.firewall.id;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Cloud-init script for a fresh Starbound install via SteamCMD.
// Requires STEAM_USER and STEAM_PASS env vars. Steam Guard must be disabled
// or pre-authorised on the account used.
function buildCloudInit(steamUser, steamPass) {
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  const { snapshotId, name, serverType, location } = req.body;

  try {
    // Include all SSH keys registered in the project so the server is accessible
    const keysRes = await fetch(`${HETZNER_API}/ssh_keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const keysData = keysRes.ok ? await keysRes.json() : { ssh_keys: [] };
    const sshKeys = (keysData.ssh_keys || []).map((k) => k.id);

    const resolvedName = name || process.env.SERVER_NAME || "starbound";
    const resolvedType = serverType || process.env.HETZNER_SERVER_TYPE || "cx23";
    const resolvedLocation = location || process.env.HETZNER_LOCATION || "hel1";

    const firewallId = await ensureFirewall(token);

    const body = {
      name: resolvedName,
      server_type: resolvedType,
      location: resolvedLocation,
      ssh_keys: sshKeys,
      firewalls: [{ firewall: firewallId }],
      labels: { managed: "starbound-panel" },
    };

    console.log("Creating server with body:", body);
    if (snapshotId) {
      body.image = snapshotId;
    } else {
      const steamUser = process.env.STEAM_USER;
      const steamPass = process.env.STEAM_PASS;
      if (!steamUser || !steamPass) {
        return res.status(500).json({
          error: "STEAM_USER and STEAM_PASS env vars are required for a fresh install (no snapshot found)",
        });
      }
      body.image = "ubuntu-22.04";
      body.user_data = buildCloudInit(steamUser, steamPass);
    }

    const r = await fetch(`${HETZNER_API}/servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    console.log("Create server response:", data);
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
