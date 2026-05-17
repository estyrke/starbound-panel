import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "./_cors.js";

const HETZNER_API = "https://api.hetzner.cloud/v1";

const ALLOWED_ACTIONS = ["poweron", "poweroff", "reboot", "shutdown"] as const;
type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") return void res.status(200).end();
  if (req.method !== "POST") return void res.status(405).json({ error: "Method not allowed" });

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return void res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  const { id, action } = req.body as { id?: number; action?: string };

  if (!id || !action) return void res.status(400).json({ error: "Missing id or action" });
  if (!(ALLOWED_ACTIONS as readonly string[]).includes(action))
    return void res
      .status(400)
      .json({ error: `Action must be one of: ${ALLOWED_ACTIONS.join(", ")}` });

  try {
    const r = await fetch(`${HETZNER_API}/servers/${id}/actions/${action as AllowedAction}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
