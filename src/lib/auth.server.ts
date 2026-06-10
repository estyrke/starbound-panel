// Aliased because the rules-of-hooks lint rule misreads this server-side
// session helper as a React hook.
import { useSession as getSession } from "@tanstack/react-start/server";

type SessionData = { authed?: boolean };

export function getAppSession() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET not configured (min 32 chars)");
  }
  return getSession<SessionData>({
    password: secret,
    name: "starbound-panel",
    maxAge: 60 * 60 * 24 * 30,
  });
}
