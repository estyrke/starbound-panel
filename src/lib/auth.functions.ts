import { createServerFn } from "@tanstack/react-start";
import { createHash, timingSafeEqual } from "node:crypto";
import { getAppSession } from "./auth.server";

// Hash both sides so the comparison is constant-time regardless of length.
function passwordsMatch(candidate: string, actual: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

export const login = createServerFn({ method: "POST" })
  .inputValidator((data: { password: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const expected = process.env.PANEL_PASSWORD;
    if (!expected) throw new Error("PANEL_PASSWORD not configured");

    if (!passwordsMatch(data.password, expected)) {
      return { ok: false };
    }

    const session = await getAppSession();
    await session.update({ authed: true });
    return { ok: true };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const session = await getAppSession();
  await session.clear();
  return { ok: true };
});

export const getAuthStatus = createServerFn().handler(async (): Promise<{ authed: boolean }> => {
  const session = await getAppSession();
  return { authed: !!session.data.authed };
});
