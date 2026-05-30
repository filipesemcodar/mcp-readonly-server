import { existsSync, readFileSync } from "node:fs";

/**
 * Reads a secret either from a file (Docker secret) or directly from an env var.
 * Convention: `${NAME}_FILE` points to a file (preferred in Swarm), else `${NAME}`.
 */
function readSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath && existsSync(filePath)) {
    return readFileSync(filePath, "utf8").trim();
  }
  const direct = process.env[name];
  if (direct && direct.trim()) {
    return direct.trim();
  }
  throw new Error(`Missing secret "${name}". Set ${name}_FILE (Docker secret path) or ${name} (env var).`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var "${name}".`);
  return v.trim();
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  /** Supabase project ref. Used as the username suffix for the Supavisor pooler
   *  (per-org role connects as <role>.<ref>). */
  projectRef: requireEnv("PROJECT_REF"),

  /** IPv4-compatible Supavisor pooler host, e.g. aws-1-<region>.pooler.supabase.com.
   *  The direct host db.<ref>.supabase.co is IPv6-only; the pooler is reachable
   *  over IPv4. Per-org connections are built as <role>.<ref>@<dbHost>:6543. */
  dbHost: requireEnv("MCP_DB_HOST"),

  /** 32-byte AES key as 64 hex chars. Same key used by scripts/provision-token.ts. */
  masterKey: readSecret("MCP_MASTER_KEY"),

  /** Static control connection string for the mcp_resolver role. */
  resolverConn: readSecret("MCP_RESOLVER_CONN"),

  /** Defense-in-depth: reject non read-only statements at the server. ON by default. */
  statementGuard: (process.env.MCP_STATEMENT_GUARD ?? "true").toLowerCase() !== "false",

  /** Resolver cache TTL — also the max delay for a revocation to take effect. */
  cacheTtlMs: Number(process.env.MCP_CACHE_TTL_MS ?? 60_000),
} as const;
