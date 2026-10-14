import { gandiProvider } from "./gandi.server";

export interface UpdateDnsBody {
  record: string;
  ip: string;
  ipv6: string;
}

export interface UpdateDnsResult {
  /** Fully qualified record the game is reachable at. */
  record: string;
  ip: string;
  ipv6: string;
}

/** A DNS service that can point a game DNS record at a server's IPs. */
export interface DnsProvider {
  updateDns(data: UpdateDnsBody): Promise<UpdateDnsResult>;
}

/** Makes no network calls; reports `localhost` so the start flow's log still shows where to connect. */
export const noneProvider: DnsProvider = {
  updateDns: async ({ ip, ipv6 }) => ({ record: "localhost", ip, ipv6 }),
};

const PROVIDERS: Record<string, DnsProvider> = { gandi: gandiProvider, none: noneProvider };

export function getDnsProvider(env: Record<string, string | undefined>): DnsProvider {
  const name = env.DNS_PROVIDER || "gandi";
  const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
  if (!provider) {
    throw new Error(
      `Unknown DNS_PROVIDER "${name}". Supported values: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return provider;
}
