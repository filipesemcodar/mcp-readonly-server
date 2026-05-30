# mcp-readonly-server

A generic, read-only **MCP server over Streamable HTTP**. It resolves a Bearer
token to a per-org Postgres role and proxies `SELECT`s. **All security
(read-only, RLS, table scope, org isolation) lives in the database** — this
server is a deliberately "dumb" authenticated proxy.

It replaces the per-client stdio setup (`@henkey/postgres-mcp-server` with a raw
connection string on each client machine). Clients now configure only a URL + a
Bearer token.

## How it works

```
Client (Claude Code / Cursor)  --Authorization: Bearer <token>-->
  Traefik (TLS + rate limit)
  mcp_readonly (this server)
    1. validate Bearer (generic 401 on failure)
    2. sha256(token) -> resolver (control connection, mcp_resolver role)
    3. decrypt role password (AES-256-GCM, master key)
    4. warm pool for the org's role (postgres.js, transaction mode :6543)
    5. tool `query` runs the SELECT
  Supabase Supavisor :6543  -> authenticates as mcp_org_<id> (session_user immutable)
  Postgres: RLS filters by internal.mcp_org_id() = lookup(session_user)
```

The DB control plane (`mcp_readers`, `mcp_org_bindings`, `mcp_org_id()`,
`provision_mcp_org`, and the token plane `mcp_api_tokens` + `mcp_resolver`) lives
in the main app repo at `scripts/mcp-readonly-infrastructure.sql`.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Express + Streamable HTTP (stateless) + `/health`; registers the `query` tool |
| `src/auth.ts` | Bearer middleware (timing-safe behaviour, generic 401) |
| `src/resolver.ts` | token hash -> org/role/conn, cache TTL, control connection |
| `src/crypto.ts` | AES-256-GCM encrypt/decrypt of the role password |
| `src/pool.ts` | warm `postgres.js` pools per role |
| `src/tools.ts` | the `query` tool + optional statement guard |
| `src/config.ts` | env/secret loading |
| `scripts/provision-token.ts` | generate a token + encrypted secret + INSERT SQL |
| `Dockerfile`, `stack.yaml` | build + Swarm deploy |

`src/index.ts`, `src/auth.ts` and `src/tools.ts` are generic and reusable in any
project. Only `src/resolver.ts` knows the control-plane shape.

## Local development

```bash
npm install
cp .env.example .env   # fill MCP_MASTER_KEY and MCP_RESOLVER_CONN
npm run dev            # tsx watch
curl localhost:3000/health
```

Point a local MCP client at `http://localhost:3000/mcp` with an
`Authorization: Bearer <token>` header (provision one first — see RUNBOOK).

## Deploy

See [RUNBOOK.md](./RUNBOOK.md). Summary:

```bash
# build + push to GHCR via CI (.github/workflows/build-and-push.yml, no PAT needed)
git tag v1.0.0 && git push origin v1.0.0   # publishes ghcr.io/filipesemcodar/mcp-readonly:1.0.0

# then, on the VPS: fill the two secrets (MCP_MASTER_KEY, MCP_RESOLVER_CONN) in
# stack.yaml, point DNS, and deploy:
docker stack deploy -c stack.yaml mcp_readonly
```

(Manual `docker build`/`push` is also possible — see [RUNBOOK.md](./RUNBOOK.md) §2.)

## Client config

```json
{
  "mcpServers": {
    "readonly-db": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN_DA_ORG" }
    }
  }
}
```

No `npx`, no connection string, no database password on the client — just the token.
