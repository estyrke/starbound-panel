// Docker access for the e2e tests: look inside world containers and clean up
// everything the emulator created for the e2e namespace.

import Docker from "dockerode";
import { namespaceFilter } from "../../dev/emulator/docker.ts";

const docker = new Docker();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


export async function exec(
  container: string,
  cmd: string[]
): Promise<{ code: number; out: string }> {
  const ex = await docker
    .getContainer(container)
    .exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
  const stream = await ex.start({ Tty: true });
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  return { code: (await ex.inspect()).ExitCode ?? -1, out: out.trim() };
}

export async function containerExists(container: string): Promise<boolean> {
  return docker
    .getContainer(container)
    .inspect()
    .then(
      () => true,
      () => false
    );
}

// Poll until `systemctl is-active <service>` says active (cloud-init is still
// installing the game when the card first turns ONLINE).
export async function waitForServiceActive(container: string, service: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = (await exec(container, ["systemctl", "is-active", service])).out;
      if (last === "active") return;
    } catch {
      last = "container not ready";
    }
    await sleep(3000);
  }
  throw new Error(`${service} in ${container} not active after ${timeoutMs} ms (last: ${last})`);
}

// Remove every container and image the emulator created for `namespace`.
export async function cleanupNamespace(namespace: string): Promise<void> {
  const filters = namespaceFilter(namespace);
  for (const c of await docker.listContainers({ all: true, filters })) {
    await docker.getContainer(c.Id).remove({ force: true, v: true });
  }
  // Snapshot images are stacked on each other: remove newest first, repeat
  // until nothing is left.
  for (let pass = 0; pass < 10; pass++) {
    const images = (await docker.listImages({ all: true, filters })).sort(
      (a, b) => b.Created - a.Created
    );
    if (images.length === 0) return;
    for (const i of images) {
      await docker
        .getImage(i.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }
}
