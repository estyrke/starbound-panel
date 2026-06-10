import { describe, expect, it } from "vitest";
import { buildDormantList, deriveIpv6Host, selectSnapshotsToDelete } from "./helpers";
import type { HetznerImage } from "./types";

describe("deriveIpv6Host", () => {
  it("turns a ::-terminated network into the ::1 host address", () => {
    expect(deriveIpv6Host("2a01:4f9:c013:291b::/64")).toBe("2a01:4f9:c013:291b::1");
  });

  it("leaves a non-::-terminated prefix unchanged", () => {
    expect(deriveIpv6Host("2a01:4f9:c013:291b:1::2/64")).toBe("2a01:4f9:c013:291b:1::2");
  });

  it("returns null for missing input", () => {
    expect(deriveIpv6Host(null)).toBeNull();
    expect(deriveIpv6Host(undefined)).toBeNull();
    expect(deriveIpv6Host("")).toBeNull();
  });
});

function snap(overrides: Partial<HetznerImage> & { id: number }): HetznerImage {
  return {
    name: null,
    description: "",
    created: "2026-01-01T00:00:00Z",
    labels: {},
    ...overrides,
  };
}

describe("buildDormantList", () => {
  it("keeps only the newest snapshot per server name", () => {
    const result = buildDormantList(
      [],
      [
        snap({ id: 1, created: "2026-01-01T00:00:00Z", labels: { "server-name": "starbound" } }),
        snap({ id: 2, created: "2026-02-01T00:00:00Z", labels: { "server-name": "starbound" } }),
      ]
    );
    expect(result).toHaveLength(1);
    expect(result[0].snapshot.id).toBe(2);
  });

  it("excludes names that have a live server", () => {
    const result = buildDormantList(
      [{ name: "starbound" }],
      [
        snap({ id: 1, labels: { "server-name": "starbound" } }),
        snap({ id: 2, labels: { "server-name": "other" } }),
      ]
    );
    expect(result.map((d) => d.name)).toEqual(["other"]);
  });

  it("falls back to the description when the server-name label is missing", () => {
    const result = buildDormantList([], [snap({ id: 1, description: "starbound:legacy" })]);
    expect(result[0].name).toBe("legacy");
  });

  it("carries server-type and location labels through", () => {
    const result = buildDormantList(
      [],
      [snap({ id: 1, labels: { "server-name": "s", "server-type": "cx23", location: "hel1" } })]
    );
    expect(result[0].serverType).toBe("cx23");
    expect(result[0].location).toBe("hel1");
  });
});

describe("selectSnapshotsToDelete", () => {
  it("returns nothing at or below the retention count", () => {
    expect(selectSnapshotsToDelete([1, 2], 2)).toEqual([]);
    expect(selectSnapshotsToDelete([1], 2)).toEqual([]);
    expect(selectSnapshotsToDelete([], 2)).toEqual([]);
  });

  it("returns the oldest ids beyond the retention count", () => {
    expect(selectSnapshotsToDelete([5, 4, 3, 2, 1], 2)).toEqual([3, 2, 1]);
  });

  it("retention 0 selects everything", () => {
    expect(selectSnapshotsToDelete([2, 1], 0)).toEqual([2, 1]);
  });

  it("rejects invalid retention values instead of deleting everything", () => {
    expect(() => selectSnapshotsToDelete([2, 1], Number.NaN)).toThrow();
    expect(() => selectSnapshotsToDelete([2, 1], -1)).toThrow();
  });
});
