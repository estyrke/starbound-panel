const HETZNER_API = "https://api.hetzner.cloud/v1";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const ALLOWED_ACTIONS = ["poweron", "poweroff", "reboot", "shutdown"];

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  const { id, action } = req.body;

  if (!id || !action) return res.status(400).json({ error: "Missing id or action" });
  if (!ALLOWED_ACTIONS.includes(action))
    return res.status(400).json({ error: `Action must be one of: ${ALLOWED_ACTIONS.join(", ")}` });

  try {
    const r = await fetch(`${HETZNER_API}/servers/${id}/actions/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
