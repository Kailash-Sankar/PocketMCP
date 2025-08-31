import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { resolve } from 'path';
import { ApiDatabaseManager } from './db.js';

// Load environment variables
config({ path: [resolve('../../.env'), resolve('.env')] });

const app = express();
const PORT = parseInt(process.env.API_PORT || '5174');
const BIND = process.env.API_BIND || '127.0.0.1';
// Use path relative to workspace root
const SQLITE_PATH = process.env.SQLITE_PATH || './data/index.db';

// Initialize database manager
const dbManager = new ApiDatabaseManager(SQLITE_PATH);

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Database diagnostics
app.get('/api/db/diag', async (req, res) => {
  try {
    const diagnostics = await dbManager.getDiagnostics();
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get diagnostics', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// Search endpoint
app.post('/api/search', async (req, res) => {
  try {
    const { query, top_k = 8, mode = 'like' } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required and must be a string' });
    }

    const startTime = Date.now();
    let matches;

    if (mode === 'like') {
      matches = await dbManager.searchLike(query, top_k);
    } else if (mode === 'vector') {
      // For now, we'll use LIKE search as fallback
      // TODO: Implement proper vector search with embeddings
      matches = await dbManager.searchLike(query, top_k);
    } else {
      return res.status(400).json({ error: 'Invalid search mode. Use "like" or "vector"' });
    }

    const tookMs = Date.now() - startTime;

    res.json({
      matches,
      took_ms: tookMs,
      query,
      mode,
      total: matches.length
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Search failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// Get specific chunk
app.get('/api/chunk/:chunk_id', async (req, res) => {
  try {
    const { chunk_id } = req.params;
    const chunk = await dbManager.getChunk(chunk_id);

    if (!chunk) {
      return res.status(404).json({ error: 'Chunk not found' });
    }

    res.json(chunk);
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get chunk', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// List documents
app.get('/api/docs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const page = parseInt(req.query.page as string) || 1;
    const offset = (page - 1) * limit;

    const result = await dbManager.getDocuments(limit, offset);

    res.json({
      documents: result.documents,
      page,
      limit,
      has_more: result.hasMore,
      next_cursor: result.hasMore ? (page + 1).toString() : undefined
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get documents', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// Serve static files in production (when web app is built)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('../web/dist')));
  
  // Catch-all handler for SPA routing
  app.get('*', (req, res) => {
    res.sendFile(resolve('../web/dist/index.html'));
  });
}

// Error handler
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong' 
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down API server...');
  dbManager.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down API server...');
  dbManager.close();
  process.exit(0);
});

// Start server
app.listen(PORT, BIND, () => {
  console.log(`🚀 PocketMCP API Server running at http://${BIND}:${PORT}`);
  console.log(`📁 SQLite path: ${SQLITE_PATH}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
