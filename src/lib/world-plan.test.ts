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

  describe("one live world per game", () => {
    const live = (name: string, game?: string) => ({
      name,
      labels: game ? { game } : ({} as Record<string, string>),
    });

    it("refuses a start when the same game already has a live world", () => {
      const r = buildWorldPlan({ ...base, name: "w2", servers: [live("w1", "starbound")] });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("spara") });
    });

    it("counts a legacy unlabelled server as Starbound", () => {
      const r = buildWorldPlan({ ...base, name: "w2", servers: [live("old")] });
      expect(r.ok).toBe(false);
    });

    it("allows a start when only the other game is live", () => {
      const r = buildWorldPlan({ ...base, name: "w2", servers: [live("f1", "factorio")] });
      expect(r.ok).toBe(true);
    });
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
  const fbase = { game: "factorio" as const, servers: [], env: {}, gameVersion: "2.0.77" };

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
    const r = buildWorldPlan({ ...fbase, name: "f1", gameVersion: null });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("version") });
  });

  it("restores from a snapshot without needing a version, keeping its version label", () => {
    const r = buildWorldPlan({
      ...fbase,
      name: "f1",
      gameVersion: null,
      snapshot: { id: 9, labels: { game: "factorio", "factorio-version": "2.0.70" } },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.request.user_data).toBeUndefined();
    expect(r.plan.request.labels["factorio-version"]).toBe("2.0.70");
  });

  describe("map-gen options", () => {
    const plan = (options: Record<string, unknown>) =>
      buildWorldPlan({ ...fbase, name: "f1", options });
    const udOf = (options: Record<string, unknown>) => {
      const r = plan(options);
      if (!r.ok) throw new Error(r.error);
      return r.plan.request.user_data ?? "";
    };

    it("passes the seed and preset to the map creation", () => {
      const ud = udOf({ seed: "12345", preset: "death-world" });
      expect(ud).toMatch(/--create \S+ .*--map-gen-seed 12345/);
      expect(ud).toMatch(/--create \S+ .*--preset death-world/);
    });

    it("omits seed and preset when left empty", () => {
      const ud = udOf({ seed: "", preset: "" });
      expect(ud).not.toContain("--map-gen-seed");
      expect(ud).not.toContain("--preset");
    });

    it("refuses a seed that isn't a number or a preset that doesn't exist", () => {
      expect(plan({ seed: "1; rm -rf /" }).ok).toBe(false);
      expect(plan({ preset: "nope" }).ok).toBe(false);
      expect(plan({ seed: "4294967296" }).ok).toBe(false);
      expect(plan({ seed: "4294967295" }).ok).toBe(true);
    });

    // The JSON a heredoc named `name` writes, parsed.
    const fileOf = (ud: string, name: string) => {
      const m = ud.match(new RegExp(`cat > \\S*${name} << 'JSON'\\n([\\s\\S]*?)\\nJSON\\n`));
      return m ? JSON.parse(m[1]) : undefined;
    };

    it("writes peaceful mode into the generated map-gen settings", () => {
      const ud = udOf({ peaceful: true });
      expect(fileOf(ud, "map-gen-settings.json")).toMatchObject({ peaceful_mode: true });
      expect(ud).toContain("--map-gen-settings /opt/factorio/map-gen-settings.json");
    });

    it("removes enemies in both settings files for no-enemies", () => {
      const ud = udOf({ noEnemies: true });
      expect(fileOf(ud, "map-gen-settings.json").autoplace_controls["enemy-base"].size).toBe(0);
      expect(fileOf(ud, "map-settings.json").enemy_expansion.enabled).toBe(false);
      expect(ud).toContain("--map-settings /opt/factorio/map-settings.json");
    });

    it("passes no settings files for a plain map", () => {
      const ud = udOf({});
      expect(ud).not.toContain("--map-gen-settings");
      expect(ud).not.toContain("--map-settings");
    });

    it("lets raw JSON win over the form fields", () => {
      const ud = udOf({
        peaceful: true,
        noEnemies: true,
        preset: "island",
        mapGenSettingsJson: '{ "width": 500 }',
        mapSettingsJson: '{"pollution":{"enabled":false}}',
      });
      expect(fileOf(ud, "map-gen-settings.json")).toEqual({ width: 500 });
      expect(fileOf(ud, "map-settings.json")).toEqual({ pollution: { enabled: false } });
      expect(ud).not.toContain("--preset");
    });

    it("refuses raw JSON that isn't a valid object", () => {
      expect(plan({ mapGenSettingsJson: "{nope" }).ok).toBe(false);
      expect(plan({ mapSettingsJson: "[1]" }).ok).toBe(false);
    });

    it("keeps Space Age off unless ticked", () => {
      const enabled = (ud: string, mod: string) =>
        fileOf(ud, "mod-list.json").mods.find((m: { name: string }) => m.name === mod).enabled;
      expect(enabled(udOf({}), "space-age")).toBe(false);
      expect(enabled(udOf({ spaceAge: false }), "space-age")).toBe(false);
      for (const mod of ["space-age", "quality", "elevated-rails"]) {
        expect(enabled(udOf({ spaceAge: true }), mod)).toBe(true);
      }
    });
  });
});
