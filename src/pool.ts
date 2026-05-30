import postgres, { type Sql } from "postgres";

// Hot pools keyed by Postgres role. Opening a connection once and reusing it
// across requests amortizes the TLS + auth handshake (the "warm pool").
const pools = new Map<string, Sql>();

export function getPoolForRole(role: string, connectionString: string): Sql {
  let sql = pools.get(role);
  if (!sql) {
    sql = postgres(connectionString, {
      max: 3, // few connections per org — Supavisor multiplexes on the other side
      idle_timeout: 30, // close idle conns when the org stops querying
      prepare: false, // REQUIRED in Supavisor transaction mode (port 6543)
      ssl: "require", // end-to-end TLS to Supabase
      connection: { application_name: "mcp_readonly" },
    });
    pools.set(role, sql);
  }
  return sql;
}

/** Close pools for roles not in the active set (call periodically if orgs grow). */
export async function evictIdle(activeRoles: Set<string>): Promise<void> {
  for (const [role, sql] of pools) {
    if (!activeRoles.has(role)) {
      await sql.end({ timeout: 5 });
      pools.delete(role);
    }
  }
}

export async function closeAllPools(): Promise<void> {
  await Promise.allSettled([...pools.values()].map((sql) => sql.end({ timeout: 5 })));
  pools.clear();
}
