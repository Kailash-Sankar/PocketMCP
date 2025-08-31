**ROLE:** You are an expert TypeScript/Node developer tasked with extending a local-first MCP server (“PocketMCP”) that ingests files from a watched folder, chunks text, embeds with `Transformers.js` (`Xenova/all-MiniLM-L6-v2`), and indexes into SQLite(+vec).
**DELIVERABLE:** Production-ready changes to add **DOCX** and **text-based PDF** ingestion with strict guardrails, minimal dependencies, and clear observability. **No OCR**, **no legacy .doc**. Keep existing TXT/MD behavior unchanged.

### Constraints & Non-Goals

* Keep it **local-first**, no cloud calls.
* **No OCR** for scanned PDFs. If a PDF has negligible text, mark “needs\_ocr” and skip.
* Do **not** introduce heavy native deps; prefer pure-JS/TS libs.
* Avoid schema bloat. Prefer a small, normalized model with good traceability.
* Backwards compatible: existing data remains valid after migration.

### Dependencies to Use (no code, just integrate)

* PDF: `pdf-parse` (simple, text-first)
* DOCX: `mammoth` (DOCX → text; headings optional)
* CSV is **out of scope** for this task.
* Existing: `@xenova/transformers`, sqlite/vec stack already in the repo.

### Configuration (env)

* `PDF_MAX_PAGES` (default: 300)
* `DOC_MAX_BYTES` (default: 10\_000\_000)
* `PDF_MIN_TEXT_CHARS` (default: 500) → below this per file → mark as `needs_ocr` and skip
* `CHUNK_SIZE` and `CHUNK_OVERLAP` already exist; keep using them.
* `VERBOSE_LOGGING` already exists; extend logs accordingly.

### Data Model

Add/confirm three levels: **documents → segments → chunks**.

* `documents`: `doc_id` (stable per file version), `path`, `content_type`, `size_bytes`, `sha256`, `mtime`, `ingest_status` (`ok|skipped|needs_ocr|too_large|error`), `notes` (short reason)
* `segments`: `segment_id`, `doc_id`, `kind` (`page|section`), `page` (int, null for DOCX), `meta` (JSON; e.g., `{heading:"...",level:2}`), `text`
* `chunks`: `chunk_id`, `segment_id`, `start_char`, `end_char`, `text`, `embedding` (vec)

**Rules**

* **PDF**: one **segment per page** (`kind=page`, `page=n`).
* **DOCX**: default to **one segment per document** unless heading splits are trivial; if splitting, `kind=section` and store heading in `meta`.
* Keep existing chunker; ensure chunks **do not cross segment boundaries**.

### Ingestion Pipeline (detector → extractor → normalizer → chunker → embedder → indexer)

1. **Detect** by extension + light magic sniff:

   * `.pdf` → PDF extractor
   * `.docx` → DOCX extractor
   * `.txt` / `.md` → existing path
   * Everything else: unchanged (ignored)
2. **Extract**

   * **PDF**: get **page-wise text**. If total chars < `PDF_MIN_TEXT_CHARS`, mark document `needs_ocr` and skip.
   * **DOCX**: produce linear text; optionally capture headings if trivial.
3. **Normalize** to `segments[]` per the rules above.
4. **Chunk** using existing `CHUNK_SIZE` / `CHUNK_OVERLAP`, **bounded within each segment**.
5. **Embed** with existing MiniLM model and batching.
6. **Index**: upsert; previous data for the same `doc_id` must be replaced atomically.

### Watcher Behavior

* Compute `sha256`. If unchanged, skip.
* On change, delete old rows for `doc_id` (cascade segments/chunks), then re-ingest.
* Respect caps:

  * PDFs with pages > `PDF_MAX_PAGES` → `ingest_status=too_large` (skip).
  * DOCX with size > `DOC_MAX_BYTES` → `too_large` (skip).
* Encrypted/secured PDFs → `ingest_status=skipped`, `notes="encrypted"`.

### Retrieval & UI Impacts (no UI rewrite; small tweaks)

* Search pipeline unchanged.
* When rendering results, add a **source badge**:

  * PDF: `filename.pdf · p.<page>`
  * DOCX: `filename.docx` (if `meta.heading` exists, append `· § <heading>`)
* When a document is skipped, surface a row in the existing **ingest status**/stats view.

### Logging & Metrics

* For each file: log `content_type`, `size`, `pages` (PDF), `text_chars`, `status`, and reason.
* Count parse failures by type (PDF/DOCX) and show in existing stats endpoint.
* For `VERBOSE_LOGGING=true`, log per-segment char counts and per-batch embedding sizes.

### Error Handling

* All extraction wrapped with clear error classes: `ParseError`, `EncryptedPdfError`, `TooLargeError`.
* On error, set `ingest_status=error` and capture short `notes` (truncate to 200 chars).

### Minimal Public API Adjustments

* Existing search endpoints remain.
* Extend any “doc detail” endpoint to include segments count and per-segment pointers (`page` or `meta.heading`).

### Acceptance Tests (automate)

Prepare fixtures (place under a `fixtures/ingest/` folder) and implement automated tests (no snapshots of large text):

* **DOCX happy path**: medium doc with headings → segments count ≥ 1, total text > 3k chars, status `ok`.
* **PDF happy path**: 10-page digital PDF → segments count == 10, cumulative chars > 5k, status `ok`.
* **PDF low-text**: 5-page scanned PDF (almost no text) → status `needs_ocr`, zero segments.
* **PDF too large**: synthetic with `pages > PDF_MAX_PAGES` → status `too_large`.
* **DOCX too large**: filesize > `DOC_MAX_BYTES` → status `too_large`.
* **Re-ingest**: modify a DOCX; sha changes → old rows removed; new rows inserted; counts updated.
* **Chunk locality**: assert all chunk `segment_id` are consistent and `start_char/end_char` within segment text length.

### Developer Ergonomics

* Add a CLI subcommand to **re-ingest a single path** and to **print an ingest summary** (counts, statuses, reasons).
* Add a feature-flag `DOCX_SPLIT_ON_HEADINGS` (default: false). If true, split on headings h1/h2 only.
* Document all env vars in README.

### Performance Guardrails

* Stream extraction where possible (PDF).
* Embed in batches of a reasonable size (keep current defaults).
* Avoid loading entire multi-hundred page PDFs into memory at once.

### Definition of Done

* Schema migration applied and idempotent.
* Unit/integration tests for all **Acceptance Tests** above are passing.
* Ingest status UI shows the new statuses and reasons.
* Searching returns results with correct **page/section** badges.
* README updated with:

  * Supported types: TXT, MD, DOCX, PDF (text-based only)
  * Limits (pages/bytes), skip reasons, and how to override envs
  * Caveat: scanned PDFs require OCR (not implemented)
