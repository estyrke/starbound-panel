const HETZNER_API = "https://api.hetzner.cloud/v1";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  const { serverId } = req.body;
  if (!serverId) return res.status(400).json({ error: "Missing serverId" });

  try {
    const r = await fetch(`${HETZNER_API}/servers/${serverId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 200 || r.status === 204) {
      return res.status(200).json({ success: true });
    }
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
