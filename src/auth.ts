import type { NextFunction, Request, Response } from "express";
import { resolveToken, type Tenant } from "./resolver.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

// Bearer auth. Returns a GENERIC 401 for any failure so callers cannot tell
// "token does not exist" from "token revoked" (avoids enumeration).
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  let tenant: Tenant | null;
  try {
    tenant = await resolveToken(token);
  } catch {
    // Resolver/control-plane failure — do not leak details.
    console.error(JSON.stringify({ level: "error", msg: "resolve_failed" }));
    res.status(500).json({ error: "internal" });
    return;
  }

  if (!tenant) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  req.tenant = tenant;
  next();
}
