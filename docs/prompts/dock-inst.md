Title: Containerize PocketMCP and publish multi-arch image with CI, ready for Portainer

Objective: Create a production-ready containerization setup for my PocketMCP project so I can run and upgrade it easily on a mini-PC via Portainer. Generate all required files and docs.
Context:

* Node + pnpm project. HTTP server on port 8001 and MCP over stdio.
* Health endpoint path must be “/health” (not “/healthz”).
* Default envs: SQLITE\_PATH, WATCH\_DIR, MODEL\_ID, CHUNK\_SIZE, CHUNK\_OVERLAP, VERBOSE\_LOGGING.
* Persist: database, kb folder, and model cache.
* Target platforms: linux/amd64 and linux/arm64.
* I want to publish to GHCR

Deliverables (create these files with complete, working content):

1. Dockerfile

* Multi-stage build (builder + runtime) on Debian slim (Node 20+).
* Non-root user, HEALTHCHECK hitting /health, expose 8001.
* Define volumes for: /app/data, /app/kb, /app/.cache.
* Sensible ENV defaults for all listed variables.
* Command should start the HTTP server.
* Keep image minimal; prune dev deps in the final stage.

2. .dockerignore

* Ignore node\_modules (except in final image), build artifacts, VCS noise, and local .env files.

3. docker-compose.yml (optional but helpful for local parity)

* One service for the API.
* Maps host ports and mounts three volumes (data, kb, model cache).
* All env vars configurable via an .env file.

4. GitHub Actions workflow (file at .github/workflows/release.yml)

* On tag push (e.g., v0.3.0) and manual dispatch.
* Buildx multi-arch (amd64, arm64).
* Log in to GHCR conditionally based on secrets.
* Tag strategy: exact version tag, major.minor stream (e.g., v0.3), and latest.
* Push SBOM and sign image if COSIGN is provided (optional).
* Cache dependencies to speed up builds.


5. Update readme: operations

* Clear steps to build and push images with buildx (both registries), including required secrets/env.
* How to select tag strategy in Portainer (pin to major.minor vs fixed version).
* Volume mappings and why they matter (database safety, model cache).
* Backup guidance for SQLite file and how to switch to an alternative vector store later.
* Healthcheck expectations and troubleshooting tips.

6. Update readme: portainer setup
* Portainer stack or container creation instructions (no auth layer assumed).
* Environment variable table (name, purpose, default).
* Volume mapping table:

  * Host path → /app/data
  * Host path → /app/kb
  * Host path → /app/.cache
* Port mapping example: host 8001 → container 8001.
* How to roll forward/back via image tags, and how health status is derived.


Implementation requirements:

* Use Debian bookworm-slim base (avoid Alpine due to ONNX/Transformers native deps).
* Ensure non-root execution and document any required file permissions.
* Volumes must be declared exactly as: /app/data, /app/kb, /app/.cache.
* Default env values set to workable defaults (SQLite path /app/data/index.db; model id Xenova/all-MiniLM-L6-v2; chunk size 1000; overlap 120; verbose false; watch dir /app/kb).
* HEALTHCHECK should fail fast if /health is not OK.
* Compose file should mirror production mounts and envs.

Tagging & versioning policy:

* Immutable tags: vX.Y.Z
* Rolling minor: vX.Y
* Rolling latest: latest
* Optional commit-SHA tag; document it in OPERATIONS.md.

Security & operability:

* Non-root user.
* Read-only root filesystem if feasible; write access only to mounted volumes. If not feasible, document why.
* Minimal packages in final image.
* Document resource limits guidance for Portainer (CPU/mem).

Assumptions:

* Project already builds locally with pnpm.
* HTTP server exposes /health.
* No GPU requirements.

Non-goals:

* No auth or TLS termination inside this container
* No Kubernetes manifests.

Acceptance checklist (write these into README as a verification section):

* Builds successfully for both amd64 and arm64 via Actions on a test tag.
* Image runs locally; /health returns healthy.
* Model files are cached in /app/.cache across restarts.
* Data persists in /app/data across container recreation.
* Portainer can pull and start the container, shows healthy status.
* Upgrading tag from vX.Y.Z to vX.Y.(Z+1) preserves data and kb.

Style & tone:

* Short, clear, no fluff. Use tables for envs/volumes. Include copy-paste friendly commands inside the generated docs (not in this prompt).

