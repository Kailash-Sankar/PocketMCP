## PocketMCP Web Tester

### Goal

Create a minimal web app to **verify SQLite works** (file present, tables exist, counts, sample query) and to **manually test search** before you swap vector backends.

### Tech

* **Frontend:** React + Vite, TailwindCSS, Zustand (simple client state)
* **Backend API:** Express (Node/TS) reusing your existing `db.ts` (SQLite connection) and simple helpers
* **Run mode:** Two processes during dev (Vite dev server + API server). In prod, Vite build served statically by the same Express server.
* **All in same repo** using **pnpm workspaces** (clean separation).

---

## Repository layout (monorepo, clean & simple)

```
/pocketmcp/               # existing repo root
  package.json            # workspaces root (add)
  pnpm-workspace.yaml     # lists packages
  .env                    # reuse envs if you want
  /apps
    /api                  # express server for diagnostics & search
    /web                  # vite + react + tailwind UI
  /src                    # (your MCP server lives here already)
  /data                   # sqlite db file lives here (index.db)
```

**Why this layout?**

* Keeps MCP code untouched under `/src`.
* Web tester is isolated under `/apps` with its own deps.

---

## Environment variables

Backend (apps/api):

* `SQLITE_PATH=./data/index.db` (or absolute path)
* `API_PORT=5174` (default)
* `API_BIND=127.0.0.1` (bind to loopback)

Frontend (apps/web):

* `VITE_API_BASE=http://127.0.0.1:5174`

---

## Backend API (apps/api)

**Purpose:** Perform DB diagnostics + expose minimal search endpoints.

### Endpoints

1. **GET `/health`**
   Returns `{ status: "ok" }` to confirm the server is running.

2. **GET `/api/db/diag`**

   * Opens SQLite using your existing `db.ts` module (reused or copied minimal).
   * Returns:

     ```json
     {
       "sqlite_path": "string",
       "exists": true,
       "tables": ["documents","vec_chunks", "..."],
       "counts": { "documents": 12, "vec_chunks": 842 },
       "vec_dim": 384,                // read from schema and/or sample row
       "vec_table_ok": true,          // SELECT 1 FROM vec_chunks LIMIT 1 succeeds
       "wal": true,                   // pragma check
       "errors": []                   // collect any failures
     }
     ```

3. **POST `/api/search`**

   * Body: `{ "query": "string", "top_k": 8 }`
   * Does: embed the query (if your embedding code is available in Node) OR perform a **fallback raw LIKE** search for smoke test if embeddings are the problem.
   * Returns:

     ```json
     {
       "matches": [
         { "chunk_id":"...", "doc_id":"...", "idx":0, "score":0.83,
           "title":"...", "preview":"first 240 chars...", "start_off":123, "end_off":456 }
       ],
       "took_ms": 12
     }
     ```

4. **GET `/api/chunk/:chunk_id`**

   * Returns `{ doc_id, chunk_id, title, text, start_off, end_off }`.

5. **GET `/api/docs`**

   * Query: `limit?=number` (default 50), `cursor?=string` (optional)
   * Returns: `{ documents:[{doc_id,title,external_id,source,updated_at}], next_cursor?:string }`.

> Note: For **quick verification**, it’s OK if `/api/search` initially uses a **fallback LIKE** search (`text LIKE '%query%'`) so you can confirm plumbing even if sqlite-vec is flaky. Add a query flag `?mode=like|vector` to switch when vectors are ready.

---

## Frontend UI (apps/web)

**Pages/components**

* **Home / Diagnostics**

  * A “DB Status” card that calls `/api/db/diag` and shows:

    * DB file path, exists?
    * Tables present & row counts
    * Vector table OK? Dim?
    * WAL status
  * A “Run smoke test” button that:

    * If no docs/chunks: shows empty state tips
    * If chunks exist: runs a canned search (or LIKE) and shows 1–3 rows

* **Search**

  * Input + “Top K” select (5/8/10/20)
  * Results list: score (3 decimals), title, preview, “View”
  * Modal/panel when clicking “View” to show full chunk via `/api/chunk/:id`
  * Optional doc filter: text field to filter by `title` client-side

* **Docs**

  * List from `/api/docs` with pagination controls (‘Next’ uses `next_cursor`)

**State**

* Use **Zustand** for:

  * `query`, `topK`, `results[]`, `loading`, `error`, `lastTookMs`
  * `dbStatus` cached after first fetch

**Styling**

* **TailwindCSS**; keep it minimal:

  * Container with max-w-4xl
  * Cards for status and results
  * Accessible modal with focus trap (or simple panel)

**Config**

* Read `import.meta.env.VITE_API_BASE` for API base URL.

---

## Scripts

At repo root:

* `pnpm -w install`
* `pnpm -w dev` → runs both `apps/api` and `apps/web` in parallel (use `concurrently` or two terminals)
* `pnpm -w build` → builds web and backend (backend can also serve built files)

In `apps/api`:

* `dev`: start Express with tsx
* `serve`: node dist/server.js
* Optional: a script to **serve `apps/web/dist`** at `/` in prod

In `apps/web`:

* `dev`: `vite`
* `build`: `vite build`
* `preview`: `vite preview`

---

## summary

* **Create** workspace config at root (`pnpm-workspace.yaml`) listing `apps/*`.
* **Create** `apps/api` (Express + TS) with endpoints above; reuse your SQLite connection module (or stub a minimal `db.ts` that points to `./data/index.db`).
* **Create** `apps/web` (Vite + React + Tailwind + Zustand) with pages/components described.
* **Wire** dev scripts to run API on `127.0.0.1:5174` and Web on `127.0.0.1:5173` with `VITE_API_BASE` pointing to the API.
* **Add** a simple production path where the API serves `apps/web/dist` statically if you run `pnpm -w build` then `pnpm --filter @pocketmcp/api serve`.

