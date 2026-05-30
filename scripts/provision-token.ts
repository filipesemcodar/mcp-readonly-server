/**
 * Provision an MCP HTTP token for an organization.
 *
 * Generates a Bearer token, hashes it (sha256), and envelope-encrypts the
 * org's Postgres role password with the master key. Prints the token ONCE
 * and the SQL INSERT to run against Supabase.
 *
 * Prereq: the org's role must already exist in the database. For a new org:
 *   SELECT internal.provision_mcp_org('<org-uuid>', '<role-password-16+>');
 * For an org already provisioned (e.g. the current stdio client), reuse its
 * existing password so the stdio setup keeps working in parallel.
 *
 * Usage (run locally, with the SAME master key the server uses):
 *   MCP_MASTER_KEY=<64-hex> npm run provision -- <org_id> <pg_role> <role_password>
 *
 * Example:
 *   MCP_MASTER_KEY=$(cat master.key) npm run provision -- \
 *     abcd1234-1111-2222-3333-444455556666 mcp_org_abcd1234 'the-existing-role-password'
 */
import { createHash, randomBytes } from "node:crypto";
import { encryptSecret } from "../src/crypto.js";

const [orgId, pgRole, rolePassword] = process.argv.slice(2);

if (!orgId || !pgRole || !rolePassword) {
  console.error("Usage: npm run provision -- <org_id> <pg_role> <role_password>");
  process.exit(1);
}

const masterKey = process.env.MCP_MASTER_KEY;
if (!masterKey) {
  console.error("Set MCP_MASTER_KEY (64 hex chars) — the SAME master key configured on the server.");
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const roleSecret = encryptSecret(rolePassword, masterKey);

const sql =
  `INSERT INTO internal.mcp_api_tokens (token_hash, org_id, pg_role, role_secret)\n` +
  `VALUES ('${tokenHash}', '${orgId}', '${pgRole}', '${roleSecret}');`;

console.log("");
console.log("=== DELIVER TO CLIENT (shown only once, via a secure channel) ===");
console.log("");
console.log(`  Authorization: Bearer ${token}`);
console.log("");
console.log("=== RUN IN SUPABASE (SQL editor / service role) ===");
console.log("");
console.log(sql);
console.log("");
