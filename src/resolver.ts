import postgres from "postgres";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { decryptSecret } from "./crypto.js";

// The ONLY static connection of the server: the control connection used to
// resolve tokens. mcp_resolver can read only internal.mcp_api_tokens.
const control = postgres(config.resolverConn, { prepare: false, ssl: "require", max: 2 });

export type Tenant = { orgId: string; pgRole: string; connStr: string };

// Short-TTL cache. Also bounds how long a revocation takes to take effect.
const cache = new Map<string, { value: Tenant; expires: number }>();

function buildConnString(pgRole: string, password: string): string {
  // IPv4-compatible Supavisor pooler: the username carries the project ref
  // (<role>.<ref>), host is the regional pooler, port 6543 (transaction mode →
  // `prepare: false` required on the driver). The direct host db.<ref>.supabase.co
  // is IPv6-only and unreachable from IPv4-only hosts.
  return (
    `postgresql://${pgRole}.${config.projectRef}:${encodeURIComponent(password)}` +
    `@${config.dbHost}:6543/postgres?sslmode=require`
  );
}

export async function resolveToken(bearer: string): Promise<Tenant | null> {
  const tokenHash = createHash("sha256").update(bearer).digest("hex");

  const cached = cache.get(tokenHash);
  if (cached && cached.expires > Date.now()) return cached.value;

  const rows = await control<{ org_id: string; pg_role: string; role_secret: string }[]>`
    select org_id, pg_role, role_secret
    from internal.mcp_api_tokens
    where token_hash = ${tokenHash} and status = 'active'
    limit 1`;
  if (rows.length === 0) return null;

  const { org_id, pg_role, role_secret } = rows[0];
  const password = decryptSecret(role_secret, config.masterKey); // AES-256-GCM, in memory only
  const value: Tenant = { orgId: org_id, pgRole: pg_role, connStr: buildConnString(pg_role, password) };

  cache.set(tokenHash, { value, expires: Date.now() + config.cacheTtlMs });

  // Best-effort usage stamp; never block the request on it.
  void control`update internal.mcp_api_tokens set last_used_at = now() where token_hash = ${tokenHash}`.catch(
    () => {},
  );

  return value;
}

export async function controlHealthcheck(): Promise<boolean> {
  try {
    await control`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeControl(): Promise<void> {
  await control.end({ timeout: 5 });
}
