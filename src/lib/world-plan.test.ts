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

describe("buildWorldPlan for Factorio", () => {
  const fbase = { game: "factorio" as const, servers: [], env: {}, factorioVersion: "2.0.77" };

  it("plans a Factorio new world with labels, firewall, defaults and Space-Age-off user_data", () => {
    const r = buildWorldPlan({ ...fbase, name: "f1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.request).toMatchObject({
      name: "f1",
      image: "ubuntu-22.04",
      server_type: "cx33",
      labels: { managed: "starbound-panel", game: "factorio", "factorio-version": "2.0.77" },
    });
    expect(r.plan.firewall).toEqual({
      name: "starbound-panel-factorio",
      ports: [{ protocol: "udp", port: "34197" }],
    });
    expect(r.plan.dnsRecord).toBe("@");
    const ud = r.plan.request.user_data ?? "";
    expect(ud).toContain("get-download/2.0.77/headless/linux64");
    expect(ud).toContain("--create");
    for (const mod of ["space-age", "quality", "elevated-rails"]) {
      expect(ud).toMatch(new RegExp(`"name": "${mod}",\\s*"enabled": false`));
    }
    expect(ud).toContain("TimeoutStopSec=");
    expect(ud).toContain('"public": false');
  });

  it("uses Factorio-specific env for type and DNS record", () => {
    const r = buildWorldPlan({
      ...fbase,
      name: "f1",
      env: {
        HETZNER_SERVER_TYPE: "cx99",
        HETZNER_SERVER_TYPE_FACTORIO: "cx43",
        GANDI_RECORD_FACTORIO: "fac",
      },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.request.server_type).toBe("cx43");
    expect(r.plan.dnsRecord).toBe("fac");
  });

  it("writes the game password and admin list from env", () => {
    const r = buildWorldPlan({
      ...fbase,
      name: "f1",
      env: { FACTORIO_GAME_PASSWORD: "it's secret", FACTORIO_ADMINS: "alice, bob" },
    });
    if (!r.ok) throw new Error(r.error);
    const ud = r.plan.request.user_data ?? "";
    expect(ud).toContain('"game_password": "it\'s secret"');
    expect(ud).toContain('["alice","bob"]');
  });

  it("refuses a new world when the version is unresolved", () => {
    const r = buildWorldPlan({ ...fbase, name: "f1", factorioVersion: null });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("version") });
  });

  it("restores from a snapshot without needing a version, keeping its version label", () => {
    const r = buildWorldPlan({
      ...fbase,
      name: "f1",
      factorioVersion: null,
      snapshot: { id: 9, labels: { game: "factorio", "factorio-version": "2.0.70" } },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.request.user_data).toBeUndefined();
    expect(r.plan.request.labels["factorio-version"]).toBe("2.0.70");
  });
});
