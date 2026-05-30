# RUNBOOK — mcp-readonly-server

Operational procedures. Constants for this project:

- `PROJECT_REF = YOUR_PROJECT_REF` (used as the pooler username suffix `<role>.<ref>`)
- `MCP_DB_HOST = aws-1-<region>.pooler.supabase.com` (Supavisor pooler, IPv4)
- Hostname: `mcp.example.com`
- Registry: `ghcr.io/filipesemcodar/mcp-readonly`
- Validated connection format: `postgresql://mcp_org_XXXXXXXX.<ref>:SENHA@aws-1-<region>.pooler.supabase.com:6543/postgres?sslmode=require` (pooler username `<role>.<ref>`, port 6543 / transaction mode → `prepare:false`).

> **Why the pooler, not the direct host:** `db.<ref>.supabase.co` resolves to
> IPv6 only, so it's unreachable from IPv4-only hosts (e.g. most VPS / Docker
> bridge networks). The Supavisor pooler `aws-1-<region>.pooler.supabase.com`
> is IPv4-compatible and accepts the custom roles when the username carries the
> ref suffix (`mcp_resolver.<ref>`, `mcp_org_X.<ref>`). Get the exact host in the
> dashboard under *Connect → Transaction pooler*.

---

## 0. One-time: DB control plane

Apply the token plane (section 8 of `scripts/mcp-readonly-infrastructure.sql` in
the app repo) in the Supabase SQL editor as a superuser. Before applying, set a
real password (16+) for `mcp_resolver`. That same password goes into the
`MCP_RESOLVER_CONN` env var in `stack.yaml` (section 1).

Verify isolation as `mcp_resolver`:

```sql
SET ROLE mcp_resolver;
SELECT count(*) FROM internal.mcp_api_tokens;  -- OK
SELECT count(*) FROM public.profiles;          -- must fail: permission denied
RESET ROLE;
```

---

## 1. One-time: secrets in `stack.yaml` (plaintext env)

This deployment keeps the secrets **inline in `stack.yaml`** as env vars (no
Docker secrets). Fill these two values on the deploy machine only:

```yaml
environment:
  # ...
  - MCP_DB_HOST=aws-1-<region>.pooler.supabase.com   # Supavisor pooler (IPv4)
  - MCP_MASTER_KEY=<openssl rand -hex 32>   # KEEP A COPY — provisioning needs it
  - MCP_RESOLVER_CONN=postgresql://mcp_resolver.<ref>:<senha>@aws-1-<region>.pooler.supabase.com:6543/postgres?sslmode=require
```

> ⚠️ The repo is public. NEVER commit a filled `stack.yaml`. Keep the committed
> copy with placeholders and fill real values only where you run the deploy.
> A leaked `MCP_MASTER_KEY` exposes every org's role password.

Generate the master key once and store it (you reuse it in section 3):

```bash
openssl rand -hex 32
```

---

## 2. Build, push, deploy

### Build + push the image (CI — preferred)

The image is built and pushed to GHCR by GitHub Actions
(`.github/workflows/build-and-push.yml`). It authenticates with the built-in
`GITHUB_TOKEN` (no PAT) and always targets
`ghcr.io/<repo-owner>/mcp-readonly` (i.e. `ghcr.io/filipesemcodar/mcp-readonly`).

Two ways to trigger it:

```bash
# A) tag-driven (recommended) — publishes :1.0.0 and :latest
git tag v1.0.0
git push origin v1.0.0

# B) manual — Actions tab -> "build-and-push" -> Run workflow -> type the version
```

Watch / confirm:

```bash
gh run watch                 # follow the latest run
gh run list --workflow build-and-push.yml
# package shows up at https://github.com/users/filipesemcodar/packages
```

The package is created automatically on the first push and starts **private**.
Decide visibility at `https://github.com/users/filipesemcodar/packages` →
`mcp-readonly` → *Package settings → Change visibility*:

- **Private** (default): the deploy machine must `docker login ghcr.io` with a
  token that has `read:packages`, otherwise `docker stack deploy` fails to pull.
- **Public**: pull needs no auth. This only exposes the image — the plaintext
  secrets in `stack.yaml` must still never be committed.

> First publish only: also link the package to this repo's visibility/perms via
> *Package settings → Manage Actions access* (Actions already has write through
> `GITHUB_TOKEN`, but linking keeps it tidy).

### Build + push manually (fallback, needs local Docker)

```bash
echo $CR_PAT | docker login ghcr.io -u filipesemcodar --password-stdin  # classic PAT, write:packages
npm run build
docker build -t ghcr.io/filipesemcodar/mcp-readonly:1.0.0 .
docker push ghcr.io/filipesemcodar/mcp-readonly:1.0.0
docker manifest inspect ghcr.io/filipesemcodar/mcp-readonly:1.0.0       # verify it landed
```

### Deploy (on the VPS / Swarm manager)

```bash
# DNS: mcp.example.com -> VPS IP
dig +short mcp.example.com

# --with-registry-auth is REQUIRED when the GHCR package is private: it
# propagates the node's `docker login ghcr.io` credentials to the service.
# Without it (or without being logged in) the task fails with "No such image".
docker stack deploy -c stack.yaml mcp_readonly --with-registry-auth
docker service ps mcp_readonly_mcp_readonly --no-trunc   # CURRENT STATE should reach Running and stay
docker service logs -f mcp_readonly_mcp_readonly
curl https://mcp.example.com/health
```

To roll out a new image: bump the tag in `stack.yaml`, push a matching git tag
(CI rebuilds), then redeploy (`order: start-first` + `failure_action: rollback`
handle the swap).

---

## 3. Provision a token for an org

The org's Postgres role must exist first.

**New org** (creates the role):

```sql
-- in Supabase
SELECT internal.provision_mcp_org('<org-uuid>', '<role-password-16+>');
-- returns e.g. mcp_org_abcd1234
```

**Existing org running in parallel with stdio** (e.g. `mcp_org_abcd1234`): reuse
the existing role password so the current stdio client keeps working. Do NOT
rotate it.

Then generate the token + INSERT SQL (locally, with the master key):

```bash
MCP_MASTER_KEY=<64-hex-master-key> npm run provision -- \
  <org-uuid> mcp_org_XXXXXXXX '<role-password>'
```

It prints the Bearer token (once) and an `INSERT INTO internal.mcp_api_tokens ...`.
Run the INSERT in Supabase. Deliver the token to the client via a secure channel.

---

## 4. Revoke a token

```sql
UPDATE internal.mcp_api_tokens SET status = 'revoked' WHERE org_id = '<org-uuid>';
```

Effective within the cache TTL (default 60s). For immediate effect, also
redeploy the service (drops the in-memory cache).

## 5. Rotate a token

Generate a new token (section 3), INSERT it, then revoke the old row.

## 6. Rotate the master key

The master key encrypts every `role_secret`. To rotate:

1. Read all `(token_hash, role_secret)` from `internal.mcp_api_tokens`.
2. For each: `decryptSecret(role_secret, OLD_KEY)` → `encryptSecret(plaintext, NEW_KEY)`.
3. `UPDATE internal.mcp_api_tokens SET role_secret = <new> WHERE token_hash = <hash>`.
4. Update `MCP_MASTER_KEY` in `stack.yaml` on the deploy machine (plaintext env —
   no Docker secret). Keep the new value out of the committed copy.
5. Redeploy the stack so containers pick up the new key:
   `docker stack deploy -c stack.yaml mcp_readonly`.

Tokens delivered to clients do NOT change (only the at-rest encryption of the
role password changes).

---

## 7. Acceptance checks

Run via a token, against the live endpoint:

- [ ] `SELECT session_user, current_user;` → returns the correct `mcp_org_X`.
- [ ] Two orgs with distinct tokens see only their own data (RLS isolation).
- [ ] `INSERT/UPDATE/DELETE` → permission denied (role is read-only).
- [ ] Calling a `public` function → permission denied (REVOKE EXECUTE).
- [ ] A table outside scope → permission denied.
- [ ] Invalid / revoked token, or no `Authorization` header → 401.
- [ ] Statement guard: `DELETE ...` → rejected by the server with a clear message.
- [ ] `/health` → 200 and validates the control connection.
- [ ] Warm pool: 2nd query of the same org is noticeably faster than the 1st.
- [ ] Logs contain no token, password, or connection string.
- [ ] Coexistence: the existing stdio client keeps working while HTTP serves the same org.

---

## 8. Troubleshooting

### Service loops: logs show `listening` then `shutting_down signal=SIGTERM`

The app booted fine (env present) but `/health` is failing, so Swarm keeps
killing the unhealthy task and restarting it (`order: start-first` shows a
`complete` task next to a `starting` one). `/health` does `select 1` over the
control connection — if that fails, you get this loop. The error is logged as
`control_healthcheck_failed` with `code`/`detail` — check `docker service logs`.

Common causes (in order):

1. **Wrong `MCP_RESOLVER_CONN`** — password typo / a missing character, wrong
   username, wrong host. (A single dropped char in the password is enough.)
2. **Control plane not applied** or the `mcp_resolver` password doesn't match
   the one in the conn string (section 0).
3. **IPv6** — the direct host `db.<ref>.supabase.co` is IPv6-only; from an
   IPv4-only node it gives `Network unreachable`. Use the IPv4 pooler
   `aws-1-<region>.pooler.supabase.com:6543` with username `<role>.<ref>`.

Validate the **exact** connection string before (re)deploying — this catches
all three:

```bash
docker run --rm postgres:16-alpine \
  psql "<your MCP_RESOLVER_CONN value>" -c "select current_user"
# expect: mcp_resolver  (a row). Auth/host errors print the real reason here.
```

### `No such image` on deploy

The Swarm node can't pull from GHCR. If the package is **private**:
`docker login ghcr.io` on the node (token with `read:packages`) **and** deploy
with `--with-registry-auth` (propagates the credential to the service). If the
package is **public**, no auth is needed.

### Pooler quirks (validated empirically)

- The **shared/regional pooler host must be exact** (`aws-1-<region>...`, not a
  generic `aws-0-...`) or you get `Tenant or user not found`.
- Custom roles work through the pooler **only with the ref suffix**
  (`mcp_resolver.<ref>`); without it → `no such user`.
- Transaction mode (6543) requires `prepare: false` on the driver (already set).
