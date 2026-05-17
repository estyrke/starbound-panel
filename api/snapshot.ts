import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "./_cors.js";

const HETZNER_API = "https://api.hetzner.cloud/v1";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") return void res.status(200).end();
  if (req.method !== "POST") return void res.status(405).json({ error: "Method not allowed" });

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return void res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  const { serverId } = req.body as { serverId?: number };
  if (!serverId) return void res.status(400).json({ error: "Missing serverId" });

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
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
