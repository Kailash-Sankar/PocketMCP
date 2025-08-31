## **PocketMCP** (Local MCP Search Server)

### 1) Goal

Create a **lightweight, local-first MCP server** that:

* **Watches a folder** (default `./kb`) and auto-ingests files.
* **Chunks & embeds** content locally with MiniLM (Transformers.js).
* Stores vectors in **SQLite + sqlite-vec**.
* Exposes **semantic search** via **MCP tools** (+ resource URIs).
* Works with **VS Code** and **Cursor** MCP clients.
* Designed for **Intel N100 / 16GB RAM** class machines.

### 2) Tech/Runtime Constraints

* **Language:** TypeScript (Node 20+).
* **Embeddings:** `Xenova/all-MiniLM-L6-v2` (384-dim), mean-pooled, L2-normalized.
* **Vector store:** **SQLite + sqlite-vec** (`vec0` virtual table).
* **DB access:** `better-sqlite3` (WAL enabled).
* **FS watcher:** `chokidar` with debounce + limited concurrency.
* **MCP:** `@modelcontextprotocol/sdk` over stdio (no network port).
* **No cloud calls**; runs fully local after first model download/cache.

### 3) Project Layout (files to create; describe responsibilities only)

* `src/server.ts` – MCP wiring: register tools/resources, read env, start watcher (if enabled).
* `src/db.ts` – DB connection, load `sqlite-vec`, create schema, indexes.
* `src/embeddings.ts` – Transformers.js MiniLM loader + `embed(texts[]) -> Float32Array[]`.
* `src/chunker.ts` – Sentence-aware chunker (\~1000 chars, 120 overlap).
* `src/ingest.ts` – Generic “raw text → chunks → vectors → DB upsert” helpers.
* `src/file-ingest.ts` – File specific ingest: path→text, hash check, upsert, delete.
* `src/watcher.ts` – Start chokidar; debounce; queue add/change/unlink to ingest/delete.
* Top-level config/metadata files: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `README.md`.

### 4) Environment Variables (with defaults)

* `SQLITE_PATH=./data/index.db`
* `WATCH_DIR=./kb` (if set, enable watcher)
* `MODEL_ID=Xenova/all-MiniLM-L6-v2`
* `CHUNK_SIZE=1000`
* `CHUNK_OVERLAP=120`

### 5) Data Model (SQLite)

* **documents**

  * `doc_id TEXT PK`
  * `external_id TEXT UNIQUE` (absolute file path or caller-supplied id)
  * `source TEXT` (`file|url|raw`)
  * `uri TEXT` (e.g., `file://...`)
  * `title TEXT`
  * `content_sha256 TEXT`
  * `created_at TEXT`, `updated_at TEXT`
* **vec\_chunks** (sqlite-vec `vec0` virtual table)

  * Metadata cols: `chunk_id TEXT PK`, `doc_id TEXT`, `idx INTEGER`, `start_off INTEGER`, `end_off INTEGER`
  * Vector col: `embedding FLOAT[384]` (must match model dim)
  * Aux col: `+text TEXT` (full chunk body; selectable)

### 6) Chunking Rules

* Target chunk length ≈ **1000 characters**, **120 char overlap**.
* Split by sentence boundaries first; fall back to sliding window.
* Record offsets for provenance (`start_off`, `end_off`).

### 7) Embedding Rules

* Use **Transformers.js** feature-extraction pipeline with `MODEL_ID`.
* **Pooling:** mean; **normalize:** true (unit vector).
* Return `Float32Array` per chunk.
* Batch embedding within a file; keep memory modest.

### 8) Search Flow (KNN)

1. Embed query → `qVec[384]`.
2. KNN against `vec_chunks.embedding` using sqlite-vec `MATCH` with `k = top_k`.
3. Return **sorted** results (ascending distance), include:

   * `chunk_id`, `doc_id`, `idx`, `score` (1 - distance), `preview` (first \~240 chars),
   * `resource` = `mcp+doc://<doc_id>#<chunk_id>`.

### 9) Ingestion & Watcher Behavior

* On **add/change**:

  * Read file → SHA-256 → if unchanged vs `documents.content_sha256`: **skip**.
  * Else: load text → chunk → embed → **transaction**:

    * Replace all `vec_chunks` rows for that `doc_id` (simple overwrite semantics).
    * Upsert `documents` row with new `content_sha256`.
* On **unlink**:

  * Delete `vec_chunks` for `doc_id`; delete `documents` row.
* **Debounce** writes (e.g., 600ms) and cap concurrency (e.g., 3).
* Default glob patterns: `**/*.md`, `**/*.txt` (PDF loaders are out of scope for v0).

### 10) MCP Surface (Tools & Resource)

* **Tool: `search`**

  * **Input:** `{ query: string, top_k?: number (default 8), filter?: { doc_ids?: string[] } }`
  * **Output:** `{ matches: [{ chunk_id, doc_id, idx, score, preview, resource }] }`
* **Tool: `upsert_documents`**

  * **Input:** `{ docs: [{ text: string, external_id?: string, title?: string, metadata?: object }] }`
  * Upserts each as a new or existing document (by `external_id`); replaces its chunks.
  * **Output:** `{ results: [{ doc_id, chunks, status: "inserted"|"updated" }] }`
* **Tool: `delete_documents`**

  * **Input:** `{ doc_ids?: string[], external_ids?: string[] }`
  * **Output:** `{ deleted_doc_ids: string[], deleted_chunks: number }`
* **Tool: `list_documents`**

  * **Input:** `{ page?: { limit?: number, cursor?: string } }` (cursor optional for future)
  * **Output:** `{ documents: [{ doc_id, external_id, title, source, updated_at }], next_cursor?: string }`
* **Resource:** `mcp+doc://<doc_id>#<chunk_id>`

  * **Returns:** `{ doc_id, chunk_id, text, start_off, end_off, title? }`

### 11) Non-Functional Requirements

* **Local-only:** after first model download/cache, no network calls.
* **Latency:** search p95 < **100 ms** for `top_k<=10` and ≤ **50k** chunks.
* **Durability:** WAL enabled; all ingest writes in transactions.
* **Safety:** path normalization; ignore temp files (`~$*`, `*.tmp`, etc.).
* **Logs:** JSON logs per tool invocation with timings and counts.

### 12) Acceptance Tests (manual)

1. **Bootstrap**

   * Run in dev mode; server prints MCP ready. No watcher errors.
2. **Initial ingest**

   * Place `a.md`, `b.md` in `WATCH_DIR`; observe “inserted” logs.
3. **Search**

   * Invoke `search` with a term present in `a.md` → top hit previews `a.md` content.
4. **Update**

   * Edit `a.md` (meaningful change) → “updated” log; search reflects new text.
   * Save `a.md` without changes → “skipped”.
5. **Delete**

   * Remove `b.md` → “deleted” log; search no longer returns its chunks.
6. **Direct upsert**

   * Call `upsert_documents` with raw text → new `doc_id`; searchable.
7. **Resource fetch**

   * Use returned `resource` URI; body matches stored chunk text.

### 13) README Expectations

Include:

* One-paragraph description.
* Architecture diagram (mermaid ok).
* Quickstart (install, env, `pnpm dev`).
* MCP client config examples for **Cursor** and **VS Code**.
* Notes about `WATCH_DIR` (choose your own; `kb` is just a convention).

### 14) Out of Scope (v0)

* PDF/Docx loaders, auth/multi-tenant, reranking, advanced filters, HTTP server.


