// Drives the panel's real factorio.com client against the fake upstream, so a
// green run means the fake speaks what the panel expects.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLatestFactorioVersion } from "../src/lib/factorio.server";
import { startFakeUpstreams, type RunningFakeUpstreams } from "./fake-upstreams";

let fake: RunningFakeUpstreams;

beforeAll(async () => {
  fake = await startFakeUpstreams({ log: () => {} });
  Object.assign(process.env, fake.env);
});

afterAll(() => fake.close());

describe("fake upstreams", () => {
  it("serves the latest Factorio version", async () => {
    expect(await getLatestFactorioVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
