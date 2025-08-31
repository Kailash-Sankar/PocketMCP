Upgrade the PocketMCP codebase to support both stdio and HTTP transports simultaneously.

**Context**

* Monorepo structure:

  * `apps/api/` → Express API server (currently serving `/health`, `/api/search`, etc.)
  * `apps/web/` → React + Vite frontend
  * `src/` → Original MCP server (`server.ts` is the main entry point, plus `db.ts`, `embeddings.ts`, `chunker.ts`, etc.)
* Today, MCP runs only via stdio from `src/server.ts`.
* The API server (`apps/api`) already uses Express conventions and exposes `/health`.

**Goals**

1. Allow the MCP server to run:

   * via stdio (unchanged),
   * via HTTP (Streamable HTTP) on LAN,
   * or both at once.
2. Expose MCP traffic at `/mcp` and health at `/health`.
3. Default HTTP bind: `0.0.0.0:8000`.
4. Use permissive CORS (allow all origins).
5. Provide structured logging for startup, requests, and errors.
6. Support graceful shutdown (SIGINT/SIGTERM).

**Implementation requirements**

* Refactor `src/server.ts` so server assembly (tools, ingestion, db) is a function returning the MCP server instance without side effects.
* Add transport runners:

  * `runStdio()` for stdio transport (reuse current behavior).
  * `runHttp()` for HTTP transport, mounted under `/mcp` and `/health`. Prefer SDK HTTP adapter if available; otherwise add a minimal Express/Node handler.
* Create a new CLI entry (e.g. `src/cli.ts`) that:

  * Reads env vars: `TRANSPORT` (`stdio` | `http` | `both`), `HTTP_HOST`, `HTTP_PORT`, `LOG_LEVEL`. Defaults: `both`, `0.0.0.0`, `8000`, `info`.
  * Builds the MCP server once and starts transports accordingly.
  * Logs startup banner showing active transports and URLs.
* Ensure stdio remains latency-optimized (no extra logging per token).
* Update `package.json` scripts:

  * `pnpm dev:mcp` → stdio only.
  * `pnpm dev:http` → http only.
  * `pnpm dev:both` (or just `pnpm dev`) → both.
  * Keep production equivalents.
* Update README:

  * Document how to run in each mode (`stdio`, `http`, `both`).
  * Show health check at `/health`.
  * Provide systemd and pm2 examples for running on a mini-PC.

**Acceptance criteria**

* `TRANSPORT=stdio` behaves exactly as before.
* `TRANSPORT=http` serves MCP at `/mcp` and health at `/health`.
* `TRANSPORT=both` runs both transports without conflict.
* `/health` returns `{ status: "ok" }`.
* CORS headers are permissive.
* Startup logs clearly show active transports and URLs.
* README and scripts reflect new usage.

