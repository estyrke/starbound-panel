import { describe, expect, it } from "vitest";
import { parseLatestStableHeadless } from "./factorio.server";

describe("parseLatestStableHeadless", () => {
  it("reads the stable headless version", () => {
    const body = { stable: { headless: "2.0.77" }, experimental: { headless: "2.1.21" } };
    expect(parseLatestStableHeadless(body)).toBe("2.0.77");
  });
  it("returns null for an unexpected shape", () => {
    expect(parseLatestStableHeadless({ stable: {} })).toBeNull();
    expect(parseLatestStableHeadless(null)).toBeNull();
    expect(parseLatestStableHeadless({ stable: { headless: "latest" } })).toBeNull();
  });
});
