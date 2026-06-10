export type HetznerServer = {
  id: number;
  name: string;
  status: string;
  created: string;
  public_net: {
    ipv4: { ip: string; dns_ptr: string } | null;
    ipv6: { ip: string; dns_ptr: { ip: string; dns_ptr: string }[] | null } | null;
  };
  server_type: { name: string; cores: number; memory: number };
  datacenter: { location: { name: string } };
  labels: Record<string, string>;
};

export type HetznerAction = {
  id: number;
  status: "running" | "success" | "error";
  error: { code: string; message: string } | null;
};

export type HetznerImage = {
  id: number;
  name: string | null;
  description: string;
  created: string;
  labels: Record<string, string>;
};
// App state

import type { StartPhase, StopPhase } from "./flows";

export type OpPhase = StartPhase | StopPhase | "reboot" | "poweron";

export interface OpState {
  phase: OpPhase;
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
