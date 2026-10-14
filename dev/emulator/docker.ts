// Everything Docker-specific the emulator needs: the label scheme that makes
// Docker the source of truth, the container run settings from the base image
// spike, the NoCloud seed, and the pre-flight check used by dev:local and the
// contract test.

import type Docker from "dockerode";
import type { Labels } from "./label-selector.ts";
import type { PublishedPort } from "./ports.ts";

export const BASE_IMAGE = "starbound-panel-base:latest";
export const PLATFORM = "linux/amd64";

// Label scheme. Containers (Hetzner servers) and, in a later ticket, images
// (snapshots) carry everything needed to rebuild the Hetzner view.
//   sbp.emulator    namespace; "dev" for pnpm dev:local, unique per test run.
//                   Also the managed marker: nothing without it is ever touched.
//   sbp.kind        "server" | "snapshot"
//   sbp.id          numeric Hetzner-style id (decimal string)
//   sbp.name        server name
//   sbp.server-type server type name, echoed back
//   sbp.location    location name, echoed back
//   sbp.created     creation time, epoch milliseconds
//   sbp.image       the image the server was created from (stock name or snapshot id)
//   sbp.labels      the Hetzner labels, as JSON
export const MANAGED_LABEL = "sbp.emulator";
export const L = {
  kind: "sbp.kind",
  id: "sbp.id",
  name: "sbp.name",
  serverType: "sbp.server-type",
  location: "sbp.location",
  created: "sbp.created",
  image: "sbp.image",
  labels: "sbp.labels",
} as const;

export const DEFAULT_NAMESPACE = "dev";

// Returns a human-readable problem, or undefined when Docker and the base
// image are ready.
export async function checkDocker(docker: Docker, image = BASE_IMAGE): Promise<string | undefined> {
  try {
    await docker.ping();
  } catch (e) {
    return `Docker is not reachable (${(e as Error).message}). Start Docker (OrbStack on macOS) or set DOCKER_HOST.`;
  }
  try {
    await docker.getImage(image).inspect();
  } catch {
    return `Base image ${image} is missing. Build it with: pnpm local:image`;
  }
  return undefined;
}

// Settings systemd needs in a container (see README, "Basavbild"). HostConfig
// is not stored in committed images, so these apply on every create.
export function systemdHostConfig(ports: PublishedPort[]) {
  const PortBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const p of ports) {
    PortBindings[`${p.port}/${p.protocol}`] = [{ HostIp: "127.0.0.1", HostPort: String(p.port) }];
  }
  return {
    CgroupnsMode: "host" as const,
    Binds: ["/sys/fs/cgroup:/sys/fs/cgroup:rw"],
    Tmpfs: { "/run": "", "/run/lock": "" },
    // Long enough for a game to write its save on soft shutdown.
    StopTimeout: 300,
    PortBindings,
  };
}

export function exposedPorts(ports: PublishedPort[]): Record<string, object> {
  return Object.fromEntries(ports.map((p) => [`${p.port}/${p.protocol}`, {}]));
}

export function serverLabels(
  namespace: string,
  s: {
    id: number;
    name: string;
    serverType: string;
    location: string;
    created: number;
    image: string;
    labels: Labels;
  }
): Labels {
  return {
    [MANAGED_LABEL]: namespace,
    [L.kind]: "server",
    [L.id]: String(s.id),
    [L.name]: s.name,
    [L.serverType]: s.serverType,
    [L.location]: s.location,
    [L.created]: String(s.created),
    [L.image]: s.image,
    [L.labels]: JSON.stringify(s.labels),
  };
}

export const SEED_DIR = "/var/lib/cloud/seed/nocloud";

// A tar archive with the NoCloud seed files, ready for container.putArchive(SEED_DIR).
// The instance-id must be unique per container, or cloud-init skips user_data.
export function nocloudSeedTar(instanceId: string, userData: string | undefined): Buffer {
  return tar({
    "meta-data": `instance-id: ${instanceId}\n`,
    "user-data": userData || "#cloud-config\n{}\n",
  });
}

// Minimal ustar writer: regular files only, short names.
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write(
      Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0") + "\0",
      136
    );
    header.write("        ", 148); // checksum placeholder: spaces
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
