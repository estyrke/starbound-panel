// Drives the panel's real Hetzner / Gandi / factorio.com clients against the
// fake upstreams, so a green run means the fakes speak what the panel expects.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLatestFactorioVersion } from "../src/lib/factorio.server";
import { updateDns } from "../src/lib/gandi.server";
import {
  cleanupOldSnapshots,
  createServer,
  deleteServer,
  getAction,
  getLatestSnapshot,
  getServer,
  listServers,
  listSnapshots,
  sendAction,
  takeSnapshot,
} from "../src/lib/hetzner.server";
import { startFakeUpstreams, type RunningFakeUpstreams } from "./fake-upstreams";

let fake: RunningFakeUpstreams;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await sleep(20);
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  fake = await startFakeUpstreams({ hetzner: { actionDelayMs: 60 }, log: () => {} });
  Object.assign(process.env, fake.env, {
    HETZNER_API_TOKEN: "fake",
    GANDI_API_KEY: "fake",
    GANDI_DOMAIN: "example.test",
    STEAM_USER: "fake",
    STEAM_PASS: "fake",
  });
});

afterAll(() => fake.close());

describe("fake upstreams", () => {
  it("seeds a live Starbound server and dormant snapshots", async () => {
    const servers = await listServers();
    expect(servers.map((s) => s.name)).toEqual(["starbound"]);
    const snaps = await listSnapshots();
    expect(snaps.map((s) => s.labels["server-name"]).sort()).toEqual(["factory", "starbound"]);
  });

  it("serves the latest Factorio version", async () => {
    expect(await getLatestFactorioVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("runs the full stop and start lifecycle for a Factorio world", async () => {
    const snapshot = await getLatestSnapshot("factory");
    expect(snapshot?.labels.game).toBe("factorio");

    const created = await createServer({
      name: "factory",
      game: "factorio",
      snapshot: snapshot && { id: snapshot.id, labels: snapshot.labels },
    });
    const id = created.server!.id;
    expect(created.server!.labels.game).toBe("factorio");
    const running = await waitFor(
      () => getServer(id),
      (s) => s?.status === "running"
    );
    expect(running?.public_net.ipv4?.ip).toBeTruthy();

    await sendAction({ action: "shutdown", id });
    await waitFor(
      () => getServer(id),
      (s) => s?.status === "off"
    );

    const snap = await takeSnapshot(id);
    await waitFor(
      () => getAction(snap.action!.id),
      (a) => a.status === "success"
    );
    const latest = await getLatestSnapshot("factory");
    expect(latest?.id).toBe(snap.image!.id);
    expect((await cleanupOldSnapshots("factory")).remaining).toBe(2);

    await deleteServer(id);
    await expect(getServer(id)).rejects.toThrow(/404|not found/i);
  });

  it("refuses a second server with the same name", async () => {
    await expect(createServer({ name: "starbound", game: "starbound" })).rejects.toThrow();
  });

  it("records DNS updates", async () => {
    const res = await updateDns({ record: "play", ip: "203.0.113.5", ipv6: "2001:db8::1" });
    expect(res.record).toBe("play.example.test");
    const records = await fetch(fake.env.GANDI_API_URL.replace("/v5/livedns", "/_debug/records"));
    expect(await records.json()).toMatchObject({
      "play.example.test A": { values: ["203.0.113.5"], ttl: 300 },
      "play.example.test AAAA": { values: ["2001:db8::1"] },
    });
  });
});
