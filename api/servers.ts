import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "./_cors.js";

const HETZNER_API = "https://api.hetzner.cloud/v1";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") return void res.status(200).end();

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return void res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  try {
    const r = await fetch(`${HETZNER_API}/servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
