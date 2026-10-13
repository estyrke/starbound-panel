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

// A router returns undefined when it has no route for the request.
export type FakeRouter = (req: FakeRequest) => FakeResponse | undefined;
