// Hetzner Cloud API — subset of fields used by this app

export type ServerStatus =
  | "running"
  | "off"
  | "stopping"
  | "starting"
  | "initializing"
  | "rebuilding"
  | "migrating"
  | "deleting"
  | "unknown";

export interface HetznerServer {
  id: number;
  name: string;
  status: ServerStatus;
  created: string;
  server_type: { name: string; cores: number; memory: number };
  datacenter: { location: { name: string } };
  public_net: {
    ipv4: { ip: string } | null;
    ipv6: { ip: string } | null;
  };
}

export interface HetznerImage {
  id: number;
  description: string;
  created: string;
  labels: Record<string, string>;
}

export interface HetznerAction {
  id: number;
  status: "running" | "success" | "error";
  error?: { code: string; message: string };
}

// App state

export interface OpState {
  phase: string;
  label: string;
}

export interface StartParams {
  name: string;
  serverType?: string;
  location?: string;
  snapshotId?: number;
}

// Discriminated union for the card list

export interface LiveEntity {
  type: "live";
  key: string;
  server: HetznerServer;
  snapshot: HetznerImage | null;
  name: string;
}

export interface DormantEntity {
  type: "dormant";
  key: string;
  snapshot: HetznerImage;
  name: string;
  serverType?: string;
  location?: string;
}

export interface PendingEntity {
  type: "pending";
  key: string;
  name: string;
  op: OpState;
}

export type Entity = LiveEntity | DormantEntity | PendingEntity;
