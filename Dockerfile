# Multi-stage build for PocketMCP
# Use Debian bookworm-slim for better compatibility with ONNX/Transformers native deps

# Builder stage
FROM node:20-bookworm-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install pnpm and dependencies
RUN npm install -g pnpm@9.15.4
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Runtime stage
FROM node:20-bookworm-slim AS runtime

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user
RUN groupadd -r pocketmcp && useradd -r -g pocketmcp -s /bin/false pocketmcp

# Set working directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9.15.4

# Copy package files for production install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Copy startup script
COPY start-all.js ./

# Create directories for volumes with proper permissions
RUN mkdir -p /app/data /app/kb /app/.cache && \
    chown -R pocketmcp:pocketmcp /app

# Set environment variables with sensible defaults
ENV NODE_ENV=production \
    TRANSPORT=both \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8001 \
    API_PORT=5174 \
    WEB_PORT=5173 \
    LOG_LEVEL=info \
    SQLITE_PATH=/app/data/index.db \
    WATCH_DIR=/app/kb \
    MODEL_ID=Xenova/all-MiniLM-L6-v2 \
    CHUNK_SIZE=1000 \
    CHUNK_OVERLAP=120 \
    MAX_CONCURRENT_FILES=5 \
    VERBOSE_LOGGING=false \
    HF_CACHE_DIR=/app/.cache

# Declare volumes
VOLUME ["/app/data", "/app/kb", "/app/.cache"]

# Switch to non-root user
USER pocketmcp

# Expose ports
EXPOSE 8001 5174 5173

# Health check - check the combined health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:5173/health || exit 1

# Start all services
CMD ["node", "start-all.js"]
