import { describe, expect, it, vi } from "vitest";
import type { StartFlowDeps, StopFlowDeps } from "./flows";
import { pollUntil, runStartFlow, runStopFlow } from "./flows";

const fast = { intervalMs: 0, timeoutMs: 1000 };

describe("pollUntil", () => {
  it("resolves with the first value that satisfies the predicate", async () => {
    const values = ["starting", "starting", "running"];
    const fn = vi.fn(async () => values.shift()!);
    await expect(pollUntil(fn, (v) => v === "running", fast)).resolves.toBe("running");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws when the deadline passes", async () => {
    await expect(
      pollUntil(
        async () => "never",
        (v) => v === "done",
        { intervalMs: 0, timeoutMs: 0 }
      )
    ).rejects.toThrow(/timed out/);
  });
});

function startDeps(overrides: Partial<StartFlowDeps> = {}): StartFlowDeps {
  const statuses = ["initializing", "running"];
  return {
    startServerInit: vi.fn(async () => ({ serverId: 42 })),
    getServerStatus: vi.fn(async () => ({ status: statuses.shift() ?? "running" })),
    updateDnsForServer: vi.fn(async () => ({
      record: "play.example.com",
      ip: "1.2.3.4",
      ipv6: "::1",
    })),
    ...overrides,
  };
}

describe("runStartFlow", () => {
  it("runs phases in order and returns the DNS record", async () => {
    const phases: string[] = [];
    const deps = startDeps();

    const res = await runStartFlow(deps, { name: "starbound" }, (p) => phases.push(p), fast);

    expect(phases).toEqual(["creating", "waiting-running", "dns"]);
    expect(res.serverId).toBe(42);
    expect(res.dnsRecord?.record).toBe("play.example.com");
    expect(res.dnsError).toBeUndefined();
    expect(deps.startServerInit).toHaveBeenCalledWith({
      data: { name: "starbound" },
    });
  });

  it("treats DNS failure as non-fatal", async () => {
    const deps = startDeps({
      updateDnsForServer: vi.fn(async () => {
        throw new Error("gandi down");
      }),
    });

    const res = await runStartFlow(deps, { name: "starbound" }, () => {}, fast);

    expect(res.dnsRecord).toBeNull();
    expect(res.dnsError).toBe("gandi down");
  });

  it("propagates a create failure", async () => {
    const deps = startDeps({
      startServerInit: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
    });

    await expect(runStartFlow(deps, { name: "starbound" }, () => {}, fast)).rejects.toThrow(
      "quota exceeded"
    );
  });
});

function stopDeps(overrides: Partial<StopFlowDeps> = {}): StopFlowDeps {
  const statuses: ({ status: string } | null)[] = [{ status: "stopping" }, { status: "off" }];
  const actionStatuses = ["running", "success"];
  return {
    stopServerInit: vi.fn(async () => ({ success: true as const })),
    getServerStatus: vi.fn(async () => statuses.shift() ?? null),
    snapshotServer: vi.fn(async () => ({ actionId: 7, imageId: 99 })),
    getActionStatus: vi.fn(async () => ({ status: actionStatuses.shift() ?? "success" })),
    deleteServerById: vi.fn(async () => ({ success: true as const })),
    ...overrides,
  };
}

describe("runStopFlow", () => {
  it("runs shutdown, snapshot, and delete in order", async () => {
    const phases: string[] = [];
    const deps = stopDeps();

    const res = await runStopFlow(deps, { serverId: 42 }, (p) => phases.push(p), fast);

    expect(phases).toEqual(["shutting-down", "waiting-off", "snapshotting", "deleting"]);
    expect(res.imageId).toBe(99);
    expect(deps.deleteServerById).toHaveBeenCalledWith({ data: { serverId: 42 } });
  });

  it("treats a vanished server as off", async () => {
    const deps = stopDeps({ getServerStatus: vi.fn(async () => null) });
    await expect(runStopFlow(deps, { serverId: 42 }, () => {}, fast)).resolves.toBeTruthy();
  });

  it("fails without deleting when the snapshot action errors", async () => {
    const deps = stopDeps({
      getActionStatus: vi.fn(async () => ({ status: "error", errorMessage: "disk full" })),
    });

    await expect(runStopFlow(deps, { serverId: 42 }, () => {}, fast)).rejects.toThrow("disk full");
    expect(deps.deleteServerById).not.toHaveBeenCalled();
  });
});
