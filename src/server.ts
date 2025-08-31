import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { DatabaseManager } from './db.js';
import { EmbeddingManager } from './embeddings.js';
import { TextChunker } from './chunker.js';
import { IngestManager } from './ingest.js';
import { FileIngestManager } from './file-ingest.js';
import { FileWatcher } from './watcher.js';

// Load environment variables with enhanced configuration
config({
  // Load .env.local first (for local overrides), then .env
  path: ['.env.local', '.env'],
  // Enable debug mode if DEBUG_DOTENV is set
  debug: process.env.DEBUG_DOTENV === 'true'
});

// Configuration
export const CONFIG = {
  // Database
  SQLITE_PATH: process.env.SQLITE_PATH || './data/index.db',
  
  // File watching
  WATCH_DIR: process.env.WATCH_DIR,
  
  // Embedding model
  MODEL_ID: process.env.MODEL_ID || 'Xenova/all-MiniLM-L6-v2',
  
  // Text chunking
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || '1000'),
  CHUNK_OVERLAP: parseInt(process.env.CHUNK_OVERLAP || '120'),
  
  // Advanced settings
  MAX_CONCURRENT_FILES: parseInt(process.env.MAX_CONCURRENT_FILES || '5'),
  VERBOSE_LOGGING: process.env.VERBOSE_LOGGING === 'true',
  
  // Environment
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Hugging Face
  HF_TOKEN: process.env.HF_TOKEN,
  HF_CACHE_DIR: process.env.HF_CACHE_DIR,
};

export interface ServerComponents {
  server: Server;
  db: DatabaseManager;
  embeddings: EmbeddingManager;
  chunker: TextChunker;
  ingestManager: IngestManager;
  fileIngestManager: FileIngestManager;
  watcher?: FileWatcher;
}

/**
 * Creates and configures a PocketMCP server instance with all components
 * @returns Configured server components
 */
export function createPocketMCPServer(): ServerComponents {
  const server = new Server(
    {
      name: 'PocketMCP',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  // Initialize components
  const db = new DatabaseManager(CONFIG.SQLITE_PATH);
  const embeddings = new EmbeddingManager(CONFIG.MODEL_ID);
  const chunker = new TextChunker({
    chunkSize: CONFIG.CHUNK_SIZE,
    chunkOverlap: CONFIG.CHUNK_OVERLAP,
  });
  const ingestManager = new IngestManager(db, embeddings, chunker);
  const fileIngestManager = new FileIngestManager(ingestManager, {
    watchDir: CONFIG.WATCH_DIR,
  });

  // Set up file watcher if watch directory is configured
  let watcher: FileWatcher | undefined;
  if (CONFIG.WATCH_DIR) {
    watcher = new FileWatcher(fileIngestManager, {
      watchDir: CONFIG.WATCH_DIR,
      supportedExtensions: ['.md', '.txt', '.pdf', '.docx'],
      initialScan: true,
    });
  }

  const components: ServerComponents = {
    server,
    db,
    embeddings,
    chunker,
    ingestManager,
    fileIngestManager,
    watcher,
  };

  setupHandlers(components);
  return components;
}

/**
 * Sets up request handlers for the MCP server
 * @param components Server components containing handlers
 */
function setupHandlers(components: ServerComponents) {
  const { server, db, ingestManager } = components;
  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search',
          description: 'Search for similar content using semantic search',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query text',
              },
              top_k: {
                type: 'number',
                description: 'Number of results to return (default: 8)',
                default: 8,
              },
              filter: {
                type: 'object',
                properties: {
                  doc_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Limit search to specific document IDs',
                  },
                },
                description: 'Optional filters for the search',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'upsert_documents',
          description: 'Insert or update documents with text content',
          inputSchema: {
            type: 'object',
            properties: {
              docs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: {
                      type: 'string',
                      description: 'The document content',
                    },
                    external_id: {
                      type: 'string',
                      description: 'Optional external identifier for the document',
                    },
                    title: {
                      type: 'string',
                      description: 'Optional title for the document',
                    },
                    metadata: {
                      type: 'object',
                      description: 'Optional metadata for the document',
                    },
                  },
                  required: ['text'],
                },
                description: 'Array of documents to upsert',
              },
            },
            required: ['docs'],
          },
        },
        {
          name: 'delete_documents',
          description: 'Delete documents by ID or external ID',
          inputSchema: {
            type: 'object',
            properties: {
              doc_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Document IDs to delete',
              },
              external_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'External IDs to delete',
              },
            },
          },
        },
        {
          name: 'list_documents',
          description: 'List all documents with pagination',
          inputSchema: {
            type: 'object',
            properties: {
              page: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Number of documents per page (default: 50)',
                    default: 50,
                  },
                  cursor: {
                    type: 'string',
                    description: 'Cursor for pagination (not implemented yet)',
                  },
                },
                description: 'Pagination options',
              },
            },
          },
        },
      ],
    }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search':
            return await handleSearch(args, ingestManager);
          case 'upsert_documents':
            return await handleUpsertDocuments(args, ingestManager);
          case 'delete_documents':
            return await handleDeleteDocuments(args, ingestManager);
          case 'list_documents':
            return await handleListDocuments(args, db);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
        }
      } catch (error) {
        console.error(`Error in tool ${name}:`, error);
        throw error instanceof McpError ? error : new McpError(
          ErrorCode.InternalError,
          `Tool ${name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
      // For now, we don't pre-list resources since they're dynamically generated
      // based on document and chunk IDs
      return {
        resources: [],
      };
    });

  // Handle resource reading
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;

      // Parse mcp+doc://doc_id#chunk_id format
      if (!uri.startsWith('mcp+doc://')) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI: ${uri}`);
      }

      try {
        const uriParts = uri.replace('mcp+doc://', '').split('#');
        if (uriParts.length !== 2) {
          throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI format: ${uri}`);
        }

        const [docId, chunkId] = uriParts;
        const chunk = db.getChunk(chunkId);
        const document = db.getDocument(docId);

        if (!chunk) {
          throw new McpError(ErrorCode.InvalidRequest, `Chunk not found: ${chunkId}`);
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: JSON.stringify({
                doc_id: docId,
                chunk_id: chunkId,
                text: chunk.text,
                start_char: chunk.start_char,
                end_char: chunk.end_char,
                title: document?.title,
                metadata: {
                  segment_id: chunk.segment_id,
                  source: document?.source,
                  uri: document?.uri,
                  external_id: document?.external_id,
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(`Error reading resource ${uri}:`, error);
        throw error instanceof McpError ? error : new McpError(
          ErrorCode.InternalError,
          `Failed to read resource: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
}

async function handleSearch(args: any, ingestManager: IngestManager): Promise<any> {
    const { query, top_k = 8, filter } = args;

    if (!query || typeof query !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Query is required and must be a string');
    }

  const docIds = filter?.doc_ids;
  const results = await ingestManager.search(query, top_k, docIds);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          matches: results,
          query,
          total: results.length,
        }, null, 2),
      },
    ],
  };
}

async function handleUpsertDocuments(args: any, ingestManager: IngestManager): Promise<any> {
    const { docs } = args;

    if (!Array.isArray(docs) || docs.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'docs is required and must be a non-empty array');
    }

  const results = await ingestManager.ingestBatch(docs);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          results: results.map(r => ({
            doc_id: r.doc_id,
            chunks: r.chunks,
            status: r.status,
            external_id: r.external_id,
          })),
        }, null, 2),
      },
    ],
  };
}

async function handleDeleteDocuments(args: any, ingestManager: IngestManager): Promise<any> {
    const { doc_ids, external_ids } = args;

    if (!doc_ids && !external_ids) {
      throw new McpError(ErrorCode.InvalidParams, 'Either doc_ids or external_ids must be provided');
    }

  const result = await ingestManager.deleteDocuments(doc_ids, external_ids);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          deleted_doc_ids: result.deletedDocIds,
          deleted_chunks: result.deletedChunks,
        }, null, 2),
      },
    ],
  };
}

async function handleListDocuments(args: any, db: DatabaseManager): Promise<any> {
    const { page } = args || {};
    const { limit = 50, cursor } = page || {};

  // Simple pagination for now - cursor not implemented
  const documents = db.listDocuments(limit, 0);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          documents: documents.map(doc => ({
            doc_id: doc.doc_id,
            external_id: doc.external_id,
            title: doc.title,
            source: doc.source,
            updated_at: doc.updated_at,
          })),
          next_cursor: documents.length === limit ? 'next' : undefined, // Simplified
        }, null, 2),
      },
    ],
  };
}

class PocketMCPServer {
  private components: ServerComponents;

  constructor() {
    this.components = createPocketMCPServer();
  }

  private get server() { return this.components.server; }
  private get db() { return this.components.db; }
  private get embeddings() { return this.components.embeddings; }
  private get ingestManager() { return this.components.ingestManager; }
  private get watcher() { return this.components.watcher; }

  async start() {
    console.log('Starting PocketMCP server...');

    // Ensure data directory exists
    const dataDir = resolve(CONFIG.SQLITE_PATH).split('/').slice(0, -1).join('/');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Initialize embedding model
    console.log('Initializing embedding model...');
    await this.embeddings.initialize();

    // File watcher is started during component initialization in CLI

    // Start MCP server
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.log('PocketMCP server ready!');
    console.log(`Database: ${CONFIG.SQLITE_PATH}`);
    console.log(`Model: ${CONFIG.MODEL_ID}`);
    console.log(`Watch directory: ${CONFIG.WATCH_DIR || 'None'}`);
    console.log(`Chunk size: ${CONFIG.CHUNK_SIZE}, overlap: ${CONFIG.CHUNK_OVERLAP}`);

    const stats = this.ingestManager.getStats();
    console.log(`Current stats: ${stats.totalDocuments} documents, ${stats.totalChunks} chunks`);
  }

  async stop() {
    console.log('Stopping PocketMCP server...');
    
    if (this.watcher) {
      await this.watcher.stop();
    }
    
    this.db.close();
    console.log('PocketMCP server stopped');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the server
async function main() {
  const server = new PocketMCPServer();
  try {
    await server.start();
  } catch (error) {
    console.error('Failed to start PocketMCP server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
