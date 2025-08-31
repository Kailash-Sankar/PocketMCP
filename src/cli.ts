#!/usr/bin/env node

import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createPocketMCPServer, ServerComponents, CONFIG } from './server.js';

// Load environment variables with enhanced configuration
config({
  // Load .env.local first (for local overrides), then .env
  path: ['.env.local', '.env'],
  // Enable debug mode if DEBUG_DOTENV is set
  debug: process.env.DEBUG_DOTENV === 'true'
});

// CLI Configuration
const CLI_CONFIG = {
  TRANSPORT: (process.env.TRANSPORT || 'both') as 'stdio' | 'http' | 'both',
  HTTP_HOST: process.env.HTTP_HOST || '0.0.0.0',
  HTTP_PORT: parseInt(process.env.HTTP_PORT || '8001'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

/**
 * Structured logging utility
 */
class Logger {
  private level: string;
  
  constructor(level: string = 'info') {
    this.level = level;
  }

  private shouldLog(level: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private log(level: string, message: string, data?: any) {
    if (!this.shouldLog(level)) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...(data && { data })
    };
    
    console.log(JSON.stringify(logEntry));
  }

  debug(message: string, data?: any) { this.log('debug', message, data); }
  info(message: string, data?: any) { this.log('info', message, data); }
  warn(message: string, data?: any) { this.log('warn', message, data); }
  error(message: string, data?: any) { this.log('error', message, data); }
}

const logger = new Logger(CLI_CONFIG.LOG_LEVEL);

/**
 * Initialize server components (shared setup)
 */
async function initializeComponents(): Promise<ServerComponents> {
  logger.info('Initializing PocketMCP server components');

  // Ensure data directory exists
  const dataDir = resolve(CONFIG.SQLITE_PATH).split('/').slice(0, -1).join('/');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.debug('Created data directory', { path: dataDir });
  }

  const components = createPocketMCPServer();

  // Initialize embedding model
  logger.info('Initializing embedding model', { model: CONFIG.MODEL_ID });
  await components.embeddings.initialize();

  // Start file watcher if configured
  if (components.watcher) {
    logger.info('Starting file watcher', { watchDir: CONFIG.WATCH_DIR });
    await components.watcher.start();
  }

  const stats = components.ingestManager.getStats();
  logger.info('Server components initialized', {
    database: CONFIG.SQLITE_PATH,
    model: CONFIG.MODEL_ID,
    watchDir: CONFIG.WATCH_DIR || 'None',
    chunkSize: CONFIG.CHUNK_SIZE,
    chunkOverlap: CONFIG.CHUNK_OVERLAP,
    documents: stats.totalDocuments,
    chunks: stats.totalChunks
  });

  return components;
}

/**
 * Run MCP server with stdio transport
 */
async function runStdio(components: ServerComponents): Promise<void> {
  logger.info('Starting stdio transport');
  
  const transport = new StdioServerTransport();
  await components.server.connect(transport);
  
  logger.info('Stdio transport ready');
}

/**
 * Run MCP server with HTTP transport
 */
async function runHttp(components: ServerComponents): Promise<void> {
  logger.info('Starting HTTP transport', {
    host: CLI_CONFIG.HTTP_HOST,
    port: CLI_CONFIG.HTTP_PORT
  });

  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false, // Use SSE streams
    allowedOrigins: ['*'], // Permissive CORS
    allowedHosts: ['*'],
    enableDnsRebindingProtection: false,
    onsessioninitialized: (sessionId) => {
      logger.debug('Session initialized', { sessionId });
    },
    onsessionclosed: (sessionId) => {
      logger.debug('Session closed', { sessionId });
    }
  });

  await components.server.connect(httpTransport);

  // Create HTTP server
  const httpServer = createServer(async (req, res) => {
    const startTime = Date.now();
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-ID');
    res.setHeader('Access-Control-Expose-Headers', 'X-Session-ID');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      
      if (url.pathname === '/health') {
        // Health check endpoint
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        
        const duration = Date.now() - startTime;
        logger.debug('Health check request', {
          method: req.method,
          path: url.pathname,
          duration,
          status: 200
        });
      } else if (url.pathname === '/mcp') {
        // MCP endpoint
        let body = '';
        if (req.method === 'POST') {
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            try {
              const parsedBody = body ? JSON.parse(body) : undefined;
              await httpTransport.handleRequest(req, res, parsedBody);
              
              const duration = Date.now() - startTime;
              logger.debug('MCP request processed', {
                method: req.method,
                path: url.pathname,
                duration,
                hasBody: !!parsedBody
              });
            } catch (error) {
              logger.error('Error processing MCP request', { error: error instanceof Error ? error.message : 'Unknown error' });
              if (!res.headersSent) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Internal server error' }));
              }
            }
          });
        } else {
          // GET request for SSE
          await httpTransport.handleRequest(req, res);
          
          const duration = Date.now() - startTime;
          logger.debug('MCP SSE connection', {
            method: req.method,
            path: url.pathname,
            duration
          });
        }
      } else {
        // 404 for other paths
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        
        const duration = Date.now() - startTime;
        logger.debug('Request not found', {
          method: req.method,
          path: url.pathname,
          duration,
          status: 404
        });
      }
    } catch (error) {
      logger.error('HTTP request error', { error: error instanceof Error ? error.message : 'Unknown error' });
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  // Start HTTP server
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(CLI_CONFIG.HTTP_PORT, CLI_CONFIG.HTTP_HOST, () => {
      logger.info('HTTP transport ready', {
        url: `http://${CLI_CONFIG.HTTP_HOST}:${CLI_CONFIG.HTTP_PORT}`,
        endpoints: {
          mcp: `http://${CLI_CONFIG.HTTP_HOST}:${CLI_CONFIG.HTTP_PORT}/mcp`,
          health: `http://${CLI_CONFIG.HTTP_HOST}:${CLI_CONFIG.HTTP_PORT}/health`
        }
      });
      resolve();
    });
    
    httpServer.on('error', (error) => {
      logger.error('HTTP server error', { error: error.message });
      reject(error);
    });
  });

  // Store server reference for cleanup
  (components as any).httpServer = httpServer;
}

/**
 * Graceful shutdown handler
 */
async function shutdown(components: ServerComponents): Promise<void> {
  logger.info('Shutting down PocketMCP server');
  
  try {
    if (components.watcher) {
      await components.watcher.stop();
    }
    
    if ((components as any).httpServer) {
      await new Promise<void>((resolve) => {
        (components as any).httpServer.close(() => resolve());
      });
    }
    
    components.db.close();
    logger.info('PocketMCP server stopped gracefully');
  } catch (error) {
    logger.error('Error during shutdown', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
  
  process.exit(0);
}

/**
 * Main CLI entry point
 */
async function main() {
  try {
    // Print startup banner
    logger.info('Starting PocketMCP server', {
      transport: CLI_CONFIG.TRANSPORT,
      httpHost: CLI_CONFIG.HTTP_HOST,
      httpPort: CLI_CONFIG.HTTP_PORT,
      logLevel: CLI_CONFIG.LOG_LEVEL,
      nodeEnv: process.env.NODE_ENV || 'development'
    });

    // Initialize components
    const components = await initializeComponents();

    // Set up graceful shutdown
    const shutdownHandler = () => shutdown(components);
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);

    // Start transports based on configuration
    switch (CLI_CONFIG.TRANSPORT) {
      case 'stdio':
        await runStdio(components);
        break;
      
      case 'http':
        await runHttp(components);
        break;
      
      case 'both':
        await Promise.all([
          runStdio(components),
          runHttp(components)
        ]);
        break;
      
      default:
        throw new Error(`Invalid transport: ${CLI_CONFIG.TRANSPORT}. Must be 'stdio', 'http', or 'both'`);
    }

    logger.info('PocketMCP server is ready', {
      activeTransports: CLI_CONFIG.TRANSPORT === 'both' ? ['stdio', 'http'] : [CLI_CONFIG.TRANSPORT]
    });

  } catch (error) {
    logger.error('Failed to start PocketMCP server', { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
