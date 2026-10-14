// Shared shapes for the fake upstream routers.

export interface FakeRequest {
  method: string;
  // Path relative to the router's mount point, always starting with "/".
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
}

// A router returns undefined when it has no route for the request. It may be
// async (the Hetzner emulator talks to Docker).
export type FakeRouter = (
  req: FakeRequest
) => FakeResponse | undefined | Promise<FakeResponse | undefined>;
