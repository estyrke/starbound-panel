// Updates Gandi LiveDNS A and AAAA records with the server's IPs.
// Required env vars: GANDI_API_KEY, GANDI_DOMAIN (zone, e.g. "example.com"),
//                    GANDI_RECORD (subdomain, e.g. "play" or "@" for root)
const GANDI_API = "https://api.gandi.net/v5/livedns";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function putRecord(apiKey, domain, record, type, value) {
  const r = await fetch(`${GANDI_API}/domains/${domain}/records/${record}/${type}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rrset_values: [value], rrset_ttl: 300 }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gandi ${type} ${r.status}: ${text}`);
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.GANDI_API_KEY;
  const domain = process.env.GANDI_DOMAIN;
  const record = process.env.GANDI_RECORD || "@";

  if (!apiKey || !domain) {
    return res.status(500).json({ error: "GANDI_API_KEY and GANDI_DOMAIN env vars are required" });
  }

  const { ip, ipv6 } = req.body;
  if (!ip && !ipv6) return res.status(400).json({ error: "Missing ip or ipv6" });

  try {
    const updates = [];
    if (ip)   updates.push(putRecord(apiKey, domain, record, "A",    ip));
    if (ipv6) updates.push(putRecord(apiKey, domain, record, "AAAA", ipv6));
    await Promise.all(updates);
    res.status(200).json({ success: true, ip, ipv6, record: `${record}.${domain}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
