const HETZNER_API = "https://api.hetzner.cloud/v1";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return res.status(500).json({ error: "HETZNER_API_TOKEN not configured" });

  try {
    const r = await fetch(`${HETZNER_API}/servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
