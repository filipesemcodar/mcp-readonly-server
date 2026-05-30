import { getPoolForRole } from "./pool.js";
import { config } from "./config.js";
import type { Tenant } from "./resolver.js";

// The read-only / RLS / scope guarantee comes 100% from the database
// (role + GRANT SELECT + REVOKE EXECUTE + policies). The server does NOT
// sanitize nor inject org_id. Even a malicious multi-statement cannot write:
// the role has no write GRANT. This immunizes the class of SQLi that broke
// @modelcontextprotocol/server-postgres (deprecated/archived in 2025).
//
// The statement guard below is defense-in-depth + UX (clearer errors), NOT the
// guarantee. It is ON by default and can be disabled via MCP_STATEMENT_GUARD.
const READONLY_RE = /^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i;

export async function runQuery(tenant: Tenant, sql: string): Promise<unknown[]> {
  if (config.statementGuard && !READONLY_RE.test(sql)) {
    throw new Error(
      "Only read-only statements (SELECT / WITH / EXPLAIN / SHOW) are accepted by this server. " +
        "The database role is read-only regardless.",
    );
  }
  const db = getPoolForRole(tenant.pgRole, tenant.connStr);
  const rows = await db.unsafe(sql);
  return rows as unknown[];
}
