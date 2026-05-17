import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "./_cors.js";

const HETZNER_API = "https://api.hetzner.cloud/v1";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") return void res.status(200).end();
  if (req.method !== "DELETE") return void res.status(405).json({ error: "Method not allowed" });

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return void res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  const { serverId } = req.body as { serverId?: number };
  if (!serverId) return void res.status(400).json({ error: "Missing serverId" });

  try {
    const r = await fetch(`${HETZNER_API}/servers/${serverId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 200 || r.status === 204) return void res.status(200).json({ success: true });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
