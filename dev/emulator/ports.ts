// Which firewall rules become published localhost ports.

export interface FirewallRule {
  direction?: string;
  protocol?: string;
  port?: string;
}

export interface PublishedPort {
  protocol: "tcp" | "udp";
  port: number;
}

const SSH_PORT = 22;

// Every inbound TCP/UDP rule except SSH, expanding "from-to" ranges.
export function publishedPorts(rules: FirewallRule[]): PublishedPort[] {
  const out = new Map<string, PublishedPort>();
  for (const rule of rules) {
    if (rule.direction !== "in") continue;
    if (rule.protocol !== "tcp" && rule.protocol !== "udp") continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(rule.port ?? "");
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let port = from; port <= to && port <= 65535; port++) {
      if (port === SSH_PORT && rule.protocol === "tcp") continue;
      out.set(`${rule.protocol}/${port}`, { protocol: rule.protocol, port });
    }
  }
  return [...out.values()];
}
