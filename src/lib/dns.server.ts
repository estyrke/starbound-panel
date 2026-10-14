import type { DnsProvider } from "./dns-provider";
import { gandiProvider } from "./gandi.server";

export type { DnsProvider, UpdateDnsBody, UpdateDnsResult } from "./dns-provider";

/** Makes no network calls; reports `localhost` so the start flow's log still shows where to connect. */
export const noneProvider: DnsProvider = {
  updateDns: async ({ ip, ipv6 }) => ({ record: "localhost", ip, ipv6 }),
};

type DnsProviderName = "gandi" | "none";

const PROVIDERS: Record<DnsProviderName, DnsProvider> = {
  gandi: gandiProvider,
  none: noneProvider,
};

const isProviderName = (name: string): name is DnsProviderName => Object.hasOwn(PROVIDERS, name);

export function getDnsProvider(env: Record<string, string | undefined>): DnsProvider {
  const name = env.DNS_PROVIDER || "gandi";
  if (!isProviderName(name)) {
    throw new Error(
      `Unknown DNS_PROVIDER "${name}". Supported values: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return PROVIDERS[name];
}
