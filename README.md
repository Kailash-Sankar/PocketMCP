# PocketMCP

**PocketMCP** is a lightweight, local-first MCP (Model Context Protocol) server that automatically watches folders, chunks and embeds files locally using Transformers.js with MiniLM, stores vectors in SQLite + sqlite-vec, and exposes semantic search capabilities to VS Code and Cursor. Designed for small machines (Intel N100, 16GB RAM) with zero external dependencies after initial model download.

## 🌟 Features

- **🔍 Semantic Search**: Find content by meaning, not just keywords
- **📁 Auto-Ingestion**: Watches folders and automatically processes new/changed files
- **⚡ Local-First**: Runs completely offline after initial model download
- **🗄️ SQLite Storage**: Fast, reliable vector storage with sqlite-vec extension
- **🔧 MCP Integration**: Native support for VS Code and Cursor via MCP protocol
- **🌐 Web Interface**: Built-in web tester for validation and manual testing
- **💾 Efficient**: Designed for resource-constrained environments
- **🔄 Real-time**: Debounced file watching with smart concurrency limits

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Web Tester](#web-tester)
- [MCP Client Integration](#mcp-client-integration)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Development](#development)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

### 1. Installation

```bash
# Clone or download the project
cd PocketMCP

# Install dependencies
pnpm install

# Setup environment
pnpm setup
# Or manually: cp .env.sample .env
```

### 2. Configuration

Edit `.env` file:

```bash
# SQLite database path
SQLITE_PATH=./data/index.db

# Directory to watch for file changes (optional)
WATCH_DIR=./kb

# Embedding model (default is recommended)
MODEL_ID=Xenova/all-MiniLM-L6-v2

# Chunking configuration
CHUNK_SIZE=1000
CHUNK_OVERLAP=120
```

### 3. Create Content Directory

```bash
# Create directory for your documents
mkdir -p kb

# Add some markdown or text files
echo "# My First Document" > kb/test.md
echo "This is a sample document for testing PocketMCP." >> kb/test.md
```

### 4. Start the Server

**Option A: MCP Server Only**

PocketMCP now supports multiple transport modes:

```bash
# Development - MCP server with both transports + file watching
pnpm dev:mcp

# Production - MCP server with both transports + file watching
pnpm build && pnpm start
```

**Transport Modes:**
- **`stdio`**: Standard MCP protocol over stdin/stdout (for VS Code, Cursor)
- **`http`**: Streamable HTTP transport with CORS support (for web clients, LAN access)
- **`both`**: Run both transports simultaneously (recommended for production)

**HTTP Transport Endpoints:**
- **MCP**: `http://0.0.0.0:8001/mcp` (Streamable HTTP MCP protocol)
- **Health**: `http://0.0.0.0:8001/health` (JSON health check)

**Environment Variables:**
- `TRANSPORT`: `stdio` | `http` | `both` (default: `both`)
- `HTTP_HOST`: HTTP bind address (default: `0.0.0.0`)
- `HTTP_PORT`: HTTP port (default: `8001`)
- `LOG_LEVEL`: `debug` | `info` | `warn` | `error` (default: `info`)

**Option B: Web Interface + API Server**
```bash
# Start web interface and API server for testing
pnpm dev
```

On first run, the server will download the MiniLM model (~100MB) and then process any files in your watch directory.

## 🌐 Web Tester

PocketMCP includes a comprehensive web interface for testing and validation.

### Access Points

- **Web Interface**: http://127.0.0.1:5173
- **API Server**: http://127.0.0.1:5174
- **Health Check**: http://127.0.0.1:5174/health

### Features

#### 📊 Database Diagnostics Panel
- Real-time database status monitoring
- Table counts and vector dimensions
- SQLite WAL mode verification
- Error detection and reporting
- One-click smoke testing

#### 🔍 Search Panel
- Interactive semantic search testing
- LIKE vs Vector search modes
- Configurable result count (top-K)
- Detailed result inspection
- Performance metrics (response time)

#### 📄 Documents Panel
- Browse all indexed documents
- Pagination support
- Document metadata display
- Creation and update timestamps

#### 🔎 Chunk Viewer
- Detailed chunk inspection modal
- Full text content display
- Metadata and offset information
- Copy-to-clipboard functionality

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health check |
| `/api/db/diag` | GET | Database diagnostics |
| `/api/search` | POST | Semantic search |
| `/api/chunk/:id` | GET | Get specific chunk |
| `/api/docs` | GET | List documents |

### Example API Usage

**Search Documents:**
```bash
curl -X POST http://127.0.0.1:5174/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "machine learning", "top_k": 5, "mode": "like"}'
```

**Get Diagnostics:**
```bash
curl http://127.0.0.1:5174/api/db/diag | jq .
```

## 🔧 MCP Client Integration

PocketMCP supports both **stdio** and **HTTP** transports for maximum compatibility.

### Option A: Stdio Transport (Recommended for Desktop Clients)

**Cursor Integration:**

1. Open **Cursor Settings** → **MCP**
2. Add a new server with these settings:

```json
{
  "command": "pnpm",
  "args": ["dev:mcp"],
  "cwd": "/path/to/PocketMCP",
  "env": {
    "TRANSPORT": "stdio",
    "SQLITE_PATH": "./data/index.db",
    "WATCH_DIR": "./kb",
    "MODEL_ID": "Xenova/all-MiniLM-L6-v2"
  }
}
```

**VS Code Integration:**

For VS Code clients that support MCP, add to your settings:

```json
{
  "mcpServers": {
    "pocketmcp": {
      "command": "pnpm",
      "args": ["dev:mcp"],
      "cwd": "/path/to/PocketMCP",
      "env": {
        "TRANSPORT": "stdio",
        "SQLITE_PATH": "./data/index.db",
        "WATCH_DIR": "./kb",
        "MODEL_ID": "Xenova/all-MiniLM-L6-v2"
      }
    }
  }
}
```

**Production: Direct Node Execution**

```json
{
  "command": "node",
  "args": ["dist/cli.js"],
  "cwd": "/path/to/PocketMCP",
  "env": {
    "TRANSPORT": "stdio",
    "SQLITE_PATH": "./data/index.db",
    "WATCH_DIR": "./kb"
  }
}
```

### Option B: HTTP Transport (For Web Clients & Remote Access)

**Start PocketMCP Server:**

First, start PocketMCP with HTTP transport enabled:

```bash
# Development
pnpm dev:mcp

# Or production
pnpm build && pnpm start

# Or HTTP only
TRANSPORT=http pnpm dev:mcp
```

**MCP Client Configuration (HTTP):**

For MCP clients that support HTTP transport, configure the connection:

```json
{
  "mcpServers": {
    "pocketmcp": {
      "transport": "http",
      "url": "http://localhost:8001/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}
```

**Web Client Integration:**

For web applications using MCP over HTTP:

```javascript
// Example: Connect to PocketMCP via HTTP
const mcpClient = new MCPClient({
  transport: 'http',
  url: 'http://localhost:8001/mcp',
  headers: {
    'Content-Type': 'application/json'
  }
});

// Initialize connection
await mcpClient.connect();

// Use MCP tools
const searchResults = await mcpClient.callTool('search', {
  query: 'machine learning',
  top_k: 5
});
```

**Remote/LAN Access:**

To access PocketMCP from other machines on your network:

```bash
# Start with network binding
HTTP_HOST=0.0.0.0 HTTP_PORT=8001 pnpm dev:mcp

# Then connect from other machines using your server's IP
# http://192.168.1.100:8001/mcp
```

**Health Check:**

Test the HTTP transport:

```bash
# Health check
curl http://localhost:8001/health

# Expected response
{"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}
```

## 📚 API Reference

### MCP Tools

#### `search`
Search for similar content using semantic search.

```json
{
  "query": "machine learning algorithms",
  "top_k": 5,
  "filter": {
    "doc_ids": ["doc_123", "doc_456"]
  }
}
```

#### `upsert_documents`
Insert or update documents programmatically.

```json
{
  "docs": [
    {
      "text": "Your document content here...",
      "external_id": "my_doc_1",
      "title": "Important Notes",
      "metadata": {}
    }
  ]
}
```

#### `delete_documents`
Delete documents by ID.

```json
{
  "doc_ids": ["doc_123"],
  "external_ids": ["my_doc_1"]
}
```

#### `list_documents`
List all documents with pagination.

```json
{
  "page": {
    "limit": 20
  }
}
```

### MCP Resources

PocketMCP provides resource URIs for accessing specific chunks:

- **Format**: `mcp+doc://<doc_id>#<chunk_id>`
- **Returns**: Complete chunk data including text, offsets, and metadata

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SQLITE_PATH` | `./data/index.db` | Path to SQLite database file |
| `WATCH_DIR` | (none) | Directory to watch for file changes |
| `MODEL_ID` | `Xenova/all-MiniLM-L6-v2` | Hugging Face model for embeddings |
| `CHUNK_SIZE` | `1000` | Target chunk size in characters |
| `CHUNK_OVERLAP` | `120` | Overlap between chunks in characters |
| `NODE_ENV` | `development` | Environment mode |
| `VERBOSE_LOGGING` | `false` | Enable detailed logs |
| `DEBUG_DOTENV` | `false` | Enable dotenv debug output |
| `API_PORT` | `5174` | Web API server port |
| `API_BIND` | `127.0.0.1` | API server bind address |

### Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start web interface + API server for testing |
| `pnpm dev:mcp` | Start MCP server (both transports + file watching) |
| `pnpm build` | Build all components |
| `pnpm start` | Start production MCP server (both transports + file watching) |
| `pnpm setup` | Create .env from template |
| `pnpm clean` | Clean build artifacts and database |

### Watch Directory Notes

- **`WATCH_DIR` is optional** - if not set, only manual document upserts work
- **Choose any directory** - `./kb` is just a convention, use whatever makes sense
- **Supported files**: `.md`, `.txt` by default (configurable in code)
- **File filtering**: Automatically ignores temp files, `.DS_Store`, `node_modules`, etc.
- **Nested directories**: Recursively watches all subdirectories

### Supported File Types

Currently supports:
- **Markdown** (`.md`)
- **Plain text** (`.txt`)

To add more file types, modify the `supportedExtensions` in the `FileIngestManager` configuration.

## 🛠️ Development

### Project Structure

```
PocketMCP/                    # Monorepo root
├── package.json             # Workspace configuration
├── pnpm-workspace.yaml      # pnpm workspace setup
├── .env                     # Environment variables
├── .env.sample              # Environment template
├── apps/
│   ├── api/                 # Express API server
│   │   ├── src/
│   │   │   ├── server.ts    # Main API server
│   │   │   └── db.ts        # Database manager
│   │   └── package.json
│   └── web/                 # React + Vite frontend
│       ├── src/
│       │   ├── App.tsx      # Main app component
│       │   ├── store.ts     # Zustand state management
│       │   ├── api.ts       # API client
│       │   └── components/  # UI components
│       └── package.json
├── src/                     # Original MCP server
│   ├── server.ts            # MCP server and main entry point
│   ├── db.ts                # SQLite database with sqlite-vec
│   ├── embeddings.ts        # Transformers.js embedding pipeline
│   ├── chunker.ts           # Text chunking with sentence awareness
│   ├── ingest.ts            # Generic document ingestion
│   ├── file-ingest.ts       # File-specific ingestion logic
│   └── watcher.ts           # File system watcher with debouncing
├── data/                    # SQLite database storage
├── kb/                      # Default watch directory (configurable)
└── README.md
```

### Development Commands

```bash
# Install dependencies
pnpm install

# Run MCP server in development mode (hot reload)
pnpm dev:mcp

# Run web tester in development mode
pnpm dev

# Build for production
pnpm build

# Run production build
pnpm start

# Run with custom environment
WATCH_DIR=./my-docs CHUNK_SIZE=500 pnpm dev:mcp
```

### Testing

```bash
# Test web tester functionality
./test-web-tester.sh

# Manual API testing
curl http://127.0.0.1:5174/health
curl http://127.0.0.1:5174/api/db/diag
```

## 🚀 Production Deployment

### systemd Service (Linux)

Create `/etc/systemd/system/pocketmcp.service`:

```ini
[Unit]
Description=PocketMCP Server
After=network.target

[Service]
Type=simple
User=pocketmcp
WorkingDirectory=/opt/pocketmcp
Environment=NODE_ENV=production
Environment=TRANSPORT=both
Environment=HTTP_HOST=0.0.0.0
Environment=HTTP_PORT=8001
Environment=SQLITE_PATH=/opt/pocketmcp/data/index.db
Environment=WATCH_DIR=/opt/pocketmcp/kb
ExecStart=/usr/bin/node dist/cli.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable pocketmcp
sudo systemctl start pocketmcp
sudo systemctl status pocketmcp
```

### PM2 Process Manager

```bash
# Install PM2 globally
npm install -g pm2

# Create ecosystem file
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'pocketmcp',
    script: 'dist/cli.js',
    cwd: '/opt/pocketmcp',
    env: {
      NODE_ENV: 'production',
      TRANSPORT: 'both',
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 8001,
      SQLITE_PATH: './data/index.db',
      WATCH_DIR: './kb'
    },
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
}
EOF

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY dist/ ./dist/
COPY data/ ./data/
COPY kb/ ./kb/

EXPOSE 8000

ENV NODE_ENV=production
ENV TRANSPORT=both
ENV HTTP_HOST=0.0.0.0
ENV HTTP_PORT=8001

CMD ["node", "dist/cli.js"]
```

### Mini-PC Setup (Intel N100)

Recommended configuration for small form factor PCs:

```bash
# System requirements
# - 16GB RAM minimum
# - 100GB+ storage
# - Ubuntu 22.04 LTS or similar

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Create user and directories
sudo useradd -r -s /bin/false pocketmcp
sudo mkdir -p /opt/pocketmcp/{data,kb,logs}
sudo chown -R pocketmcp:pocketmcp /opt/pocketmcp

# Deploy application
sudo -u pocketmcp git clone <repo> /opt/pocketmcp
cd /opt/pocketmcp
sudo -u pocketmcp npm install
sudo -u pocketmcp npm run build

# Configure firewall (if needed)
sudo ufw allow 8001/tcp

# Setup systemd service (see above)
```

### Health Monitoring

```bash
# Health check endpoint
curl http://localhost:8001/health

# Expected response
{"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}

# Log monitoring
journalctl -u pocketmcp -f  # systemd
pm2 logs pocketmcp          # PM2
```

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph "MCP Clients"
        A[VS Code] 
        B[Cursor]
    end
    
    subgraph "Web Interface"
        W1[React Frontend<br/>:5173]
        W2[Express API<br/>:5174]
    end
    
    subgraph "PocketMCP Server"
        C[MCP Server<br/>stdio transport]
        D[File Watcher<br/>chokidar]
        E[Text Chunker<br/>~1000 chars]
        F[Embeddings<br/>Transformers.js<br/>MiniLM-L6-v2]
        G[SQLite + sqlite-vec<br/>Vector Database]
    end
    
    subgraph "File System"
        H[Watch Directory<br/>./kb/]
        I[Data Directory<br/>./data/]
    end
    
    A -.->|MCP Tools| C
    B -.->|MCP Tools| C
    W1 -->|HTTP API| W2
    W2 -->|Database Access| G
    C --> D
    D -->|File Changes| E
    E -->|Text Chunks| F
    F -->|384-dim Vectors| G
    G -.->|Search Results| C
    D -.->|Monitors| H
    G -.->|Stores in| I
    
    classDef mcpClient fill:#e1f5fe
    classDef webInterface fill:#fff3e0
    classDef server fill:#f3e5f5
    classDef storage fill:#e8f5e8
    
    class A,B mcpClient
    class W1,W2 webInterface
    class C,D,E,F,G server
    class H,I storage
```

## 📊 Performance & Limits

- **Sweet spot**: 10K-100K chunks on modest hardware
- **Query latency**: Sub-100ms for `top_k <= 10` on typical corpora
- **Memory usage**: ~100MB for model + minimal overhead per document
- **Concurrency**: Limited to 3 simultaneous file operations by default
- **File size limit**: 50MB per file (configurable)

## 🔧 Troubleshooting

### Model Download Issues
If the embedding model fails to download:
- Check internet connection for initial download
- Model cache location: `~/.cache/huggingface/transformers/`
- Clear cache and retry if needed

### SQLite Extension Issues
If `sqlite-vec` fails to load:
- Ensure `sqlite-vec` npm package is installed
- Check that your system supports the required SQLite version
- The system automatically falls back to regular SQLite tables if vec0 virtual tables fail

### File Watching Issues
- **Files not being detected**: Check file extensions and ignore patterns
- **High CPU usage**: Increase debounce time with larger `debounceMs` values
- **Permission errors**: Ensure read/write access to watch and data directories

### Web Interface Issues
- **API not accessible**: Ensure API server is running on port 5174
- **Database not found**: Check `SQLITE_PATH` environment variable
- **CORS errors**: API server includes CORS headers for local development

### Memory Issues
- Reduce `CHUNK_SIZE` for lower memory usage
- Process fewer files simultaneously by reducing `maxConcurrency`
- Consider using a smaller embedding model (though this requires code changes)

### Common Error Messages

**"Too many parameter values were provided"**
- This was a known issue with sqlite-vec virtual tables, now fixed with automatic fallback

**"Failed to load sqlite-vec extension"**
- System automatically falls back to regular SQLite tables with JSON embeddings

**"Database file does not exist"**
- Run the MCP server first to create the database, or check the `SQLITE_PATH`

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🙏 Acknowledgments

- **sqlite-vec** for fast vector similarity search
- **Transformers.js** for local embedding generation
- **Model Context Protocol** for standardized tool integration
- **Hugging Face** for the MiniLM model
- **React + Vite** for the modern web interface
- **TailwindCSS** for beautiful, responsive styling