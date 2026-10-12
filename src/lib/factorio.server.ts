// Resolves the latest stable headless Factorio version from factorio.com.

const LATEST_RELEASES_URL = "https://factorio.com/api/latest-releases";

// Extracts stable.headless from the latest-releases response, or null if the
// shape isn't what we expect.
export function parseLatestStableHeadless(body: unknown): string | null {
  const v = (body as { stable?: { headless?: unknown } } | null)?.stable?.headless;
  return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

// Returns null (never throws) when the version can't be resolved, so the plan
// builder can refuse the new world with a clear message.
export async function getLatestFactorioVersion(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_RELEASES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return parseLatestStableHeadless(await res.json());
  } catch {
    return null;
  }
}
