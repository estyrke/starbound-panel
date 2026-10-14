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
