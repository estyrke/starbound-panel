import { describe, expect, it } from "vitest";
import { buildWorldPlan } from "./world-plan";

const env = { STEAM_USER: "u", STEAM_PASS: "p" };
const base = { game: "starbound" as const, servers: [], env };

describe("buildWorldPlan", () => {
  it("plans a Starbound new world with today's defaults", () => {
    const r = buildWorldPlan({ ...base, name: "w1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.request).toMatchObject({
      name: "w1",
      image: "ubuntu-22.04",
      server_type: "cx23",
      location: "hel1",
      labels: { managed: "starbound-panel", game: "starbound" },
    });
    expect(r.plan.request.user_data).toContain("steamcmd");
    expect(r.plan.firewall.name).toBe("starbound-panel");
    expect(r.plan.dnsRecord).toBe("@");
  });

  it("plans a restore from a snapshot without user_data", () => {
    const r = buildWorldPlan({
      ...base,
      name: "w1",
      env: {},
      snapshot: { id: 7, labels: { game: "starbound" } },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.request.image).toBe("7");
    expect(r.plan.request.user_data).toBeUndefined();
  });

  it("counts a legacy snapshot with no game label as Starbound", () => {
    const r = buildWorldPlan({ ...base, name: "w1", snapshot: { id: 7, labels: {} } });
    expect(r.ok).toBe(true);
  });

  it("refuses a fresh install without Steam credentials", () => {
    const r = buildWorldPlan({ ...base, name: "w1", env: {} });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("STEAM_USER") });
  });

  it("refuses a name that already has a live server", () => {
    const r = buildWorldPlan({ ...base, name: "w1", servers: [{ name: "w1" }] });
    expect(r.ok).toBe(false);
  });

  it("resolves the DNS record per game, falling back to GANDI_RECORD", () => {
    const rec = (e: Record<string, string>) => {
      const r = buildWorldPlan({ ...base, name: "w", env: { ...env, ...e } });
      return r.ok && r.plan.dnsRecord;
    };
    expect(rec({ GANDI_RECORD: "play" })).toBe("play");
    expect(rec({ GANDI_RECORD: "play", GANDI_RECORD_STARBOUND: "sb" })).toBe("sb");
  });
});
