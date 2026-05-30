import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { authMiddleware } from "./auth.js";
import { runQuery } from "./tools.js";
import { controlHealthcheck, closeControl, type Tenant } from "./resolver.js";
import { closeAllPools } from "./pool.js";

// JSON.stringify replacer: int8/numeric can arrive as bigint — make them safe.
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// One McpServer per request, with the `query` tool bound to this request's
// tenant via closure. Keeps the transport stateless (sessionIdGenerator:
// undefined) so replicas need no sticky sessions.
function buildServer(tenant: Tenant): McpServer {
  const server = new McpServer({ name: "mcp-readonly", version: "1.0.0" });

  server.registerTool(
    "query",
    {
      title: "SQL read-only query",
      description:
        "Run a read-only SQL query (SELECT / WITH / EXPLAIN / SHOW) against your organization's data. " +
        "Results are automatically scoped to your organization by row-level security.",
      inputSchema: { sql: z.string().describe("A read-only SQL statement") },
    },
    async ({ sql }) => {
      const rows = await runQuery(tenant, sql);
      return { content: [{ type: "text", text: JSON.stringify(rows, jsonReplacer, 2) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  const ok = await controlHealthcheck();
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded" });
});

app.post("/mcp", authMiddleware, async (req, res) => {
  const tenant = req.tenant!;
  const start = Date.now();
  const server = buildServer(tenant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
    // Structured log — org + latency only, never token/password/conn string.
    console.log(JSON.stringify({ level: "info", msg: "request_done", orgId: tenant.orgId, ms: Date.now() - start }));
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    console.error(JSON.stringify({ level: "error", msg: "mcp_error", orgId: tenant.orgId }));
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Stateless transport: no session-based stream resumption.
function methodNotAllowed(_req: express.Request, res: express.Response): void {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const httpServer = app.listen(config.port, () => {
  console.log(JSON.stringify({ level: "info", msg: "listening", port: config.port, statementGuard: config.statementGuard }));
});

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: "info", msg: "shutting_down", signal }));
  httpServer.close();
  await Promise.allSettled([closeAllPools(), closeControl()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
