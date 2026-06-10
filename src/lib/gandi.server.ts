const GANDI_API = "https://api.gandi.net/v5/livedns";

async function putRecord(
  apiKey: string,
  domain: string,
  record: string,
  type: "A" | "AAAA",
  value: string
): Promise<void> {
  const r = await fetch(`${GANDI_API}/domains/${domain}/records/${record}/${type}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rrset_values: [value], rrset_ttl: 300 }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gandi ${type} ${r.status}: ${text}`);
  }
}

interface UpdateDnsBody {
  ip: string;
  ipv6: string;
}

export const updateDns = async (
  data: UpdateDnsBody
): Promise<{ success: boolean; ip: string; ipv6: string; record: string }> => {
  const apiKey = process.env.GANDI_API_KEY;
  const domain = process.env.GANDI_DOMAIN;
  const record = process.env.GANDI_RECORD ?? "@";

  if (!apiKey || !domain) throw new Error("GANDI_API_KEY and GANDI_DOMAIN env vars are required");

  const { ip, ipv6 } = data;

  try {
    const updates: Promise<void>[] = [];
    if (ip) updates.push(putRecord(apiKey, domain, record, "A", ip));
    if (ipv6) updates.push(putRecord(apiKey, domain, record, "AAAA", ipv6));
    await Promise.all(updates);
    return { success: true, ip, ipv6, record: `${record}.${domain}` };
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
};
