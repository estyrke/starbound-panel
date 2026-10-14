import { afterEach, describe, expect, it, vi } from "vitest";
import { gandiProvider } from "./gandi.server";
import { getDnsProvider, noneProvider } from "./dns.server";

describe("getDnsProvider", () => {
  it("defaults to gandi when DNS_PROVIDER is unset or empty", () => {
    expect(getDnsProvider({})).toBe(gandiProvider);
    expect(getDnsProvider({ DNS_PROVIDER: "" })).toBe(gandiProvider);
  });

  it("selects gandi and none by name", () => {
    expect(getDnsProvider({ DNS_PROVIDER: "gandi" })).toBe(gandiProvider);
    expect(getDnsProvider({ DNS_PROVIDER: "none" })).toBe(noneProvider);
  });

  it("fails clearly on an unknown provider", () => {
    expect(() => getDnsProvider({ DNS_PROVIDER: "route53" })).toThrow(/DNS_PROVIDER.*route53/);
  });
});

describe("none provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns localhost with the given IPs and makes no network calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await noneProvider.updateDns({ record: "play", ip: "127.0.0.1", ipv6: "::1" });
    expect(res).toEqual({ record: "localhost", ip: "127.0.0.1", ipv6: "::1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
