import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { getAppSession } from "./auth.server";

export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const session = await getAppSession();
  if (!session.data.authed) {
    setResponseStatus(401);
    throw new Error("Unauthorized");
  }
  return next();
});
