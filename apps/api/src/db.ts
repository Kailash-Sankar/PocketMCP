import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolve } from 'path';

export interface Document {
  doc_id: string;
  external_id: string;
  source: 'file' | 'url' | 'raw';
  uri: string;
  title: string;
  content_sha256: string;
  created_at: string;
  updated_at: string;
}

export interface VecChunk {
  chunk_id: string;
  doc_id: string;
  idx: number;
  start_off: number;
  end_off: number;
  text: string;
  embedding?: Float32Array;
}

export interface SearchResult {
  chunk_id: string;
  doc_id: string;
  idx: number;
  score: number;
  preview: string;
  text: string;
  title?: string;
  start_off: number;
  end_off: number;
}

export interface DbDiagnostics {
  sqlite_path: string;
  exists: boolean;
  tables: string[];
  counts: Record<string, number>;
  vec_dim?: number;
  vec_table_ok: boolean;
  wal: boolean;
  errors: string[];
}

export class ApiDatabaseManager {
  private db: Database.Database | null = null;
  private sqlitePath: string;

  constructor(sqlitePath: string) {
    this.sqlitePath = resolve(sqlitePath);
  }

  private connect(): Database.Database {
    if (!this.db) {
      this.db = new Database(this.sqlitePath);
    }
    return this.db;
  }

  async getDiagnostics(): Promise<DbDiagnostics> {
    const diag: DbDiagnostics = {
      sqlite_path: this.sqlitePath,
      exists: existsSync(this.sqlitePath),
      tables: [],
      counts: {},
      vec_table_ok: false,
      wal: false,
      errors: []
    };

    if (!diag.exists) {
      diag.errors.push('SQLite database file does not exist');
      return diag;
    }

    try {
      const db = this.connect();

      // Get tables
      const tablesResult = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      diag.tables = tablesResult.map(row => row.name);

      // Get counts for each table
      for (const tableName of diag.tables) {
        try {
          const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
          diag.counts[tableName] = countResult.count;
        } catch (error) {
          diag.errors.push(`Failed to count rows in ${tableName}: ${error}`);
        }
      }

      // Check if vec_chunks table works
      if (diag.tables.includes('vec_chunks')) {
        try {
          db.prepare('SELECT 1 FROM vec_chunks LIMIT 1').get();
          diag.vec_table_ok = true;

          // Try to get vector dimension from a sample row
          if (diag.counts.vec_chunks > 0) {
            try {
              const sample = db.prepare('SELECT embedding FROM vec_chunks LIMIT 1').get() as { embedding: string };
              if (sample?.embedding) {
                const parsed = JSON.parse(sample.embedding);
                if (Array.isArray(parsed)) {
                  diag.vec_dim = parsed.length;
                  // Check if this looks like unpooled embeddings (should be 384 for all-MiniLM-L6-v2)
                  if (parsed.length > 1000) {
                    diag.errors.push(`Vector dimension ${parsed.length} seems too large. Expected 384 for all-MiniLM-L6-v2. This may indicate unpooled token-level embeddings.`);
                  }
                }
              }
            } catch (error) {
              diag.errors.push(`Failed to parse embedding dimension: ${error}`);
            }
          }
        } catch (error) {
          diag.errors.push(`vec_chunks table check failed: ${error}`);
        }
      }

      // Check WAL mode
      try {
        const walResult = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
        diag.wal = walResult.journal_mode?.toLowerCase() === 'wal';
      } catch (error) {
        diag.errors.push(`WAL check failed: ${error}`);
      }

    } catch (error) {
      diag.errors.push(`Database connection failed: ${error}`);
    }

    return diag;
  }

  async searchLike(query: string, topK: number = 8): Promise<SearchResult[]> {
    try {
      const db = this.connect();
      const searchQuery = `%${query}%`;
      
      const stmt = db.prepare(`
        SELECT 
          vec_chunks.chunk_id,
          vec_chunks.doc_id,
          vec_chunks.idx,
          vec_chunks.start_off,
          vec_chunks.end_off,
          vec_chunks.text,
          documents.title
        FROM vec_chunks
        LEFT JOIN documents ON vec_chunks.doc_id = documents.doc_id
        WHERE vec_chunks.text LIKE ?
        ORDER BY vec_chunks.doc_id, vec_chunks.idx
        LIMIT ?
      `);

      const results = stmt.all(searchQuery, topK) as any[];

      return results.map(row => ({
        chunk_id: row.chunk_id,
        doc_id: row.doc_id,
        idx: row.idx,
        score: 0.5, // Placeholder score for LIKE search
        preview: row.text.substring(0, 240) + (row.text.length > 240 ? '...' : ''),
        text: row.text,
        title: row.title,
        start_off: row.start_off,
        end_off: row.end_off
      }));
    } catch (error) {
      throw new Error(`Search failed: ${error}`);
    }
  }

  async searchVector(queryEmbedding: Float32Array, topK: number = 8): Promise<SearchResult[]> {
    try {
      const db = this.connect();
      
      // Get all chunks and compute similarity in memory (fallback approach)
      const stmt = db.prepare(`
        SELECT 
          vec_chunks.chunk_id,
          vec_chunks.doc_id,
          vec_chunks.idx,
          vec_chunks.start_off,
          vec_chunks.end_off,
          vec_chunks.text,
          vec_chunks.embedding,
          documents.title
        FROM vec_chunks
        LEFT JOIN documents ON vec_chunks.doc_id = documents.doc_id
      `);

      const allChunks = stmt.all() as any[];

      // Compute cosine similarity for each chunk
      const similarities = allChunks.map(chunk => {
        let similarity = 0;
        try {
          const chunkEmbedding = new Float32Array(JSON.parse(chunk.embedding));
          similarity = this.cosineSimilarity(queryEmbedding, chunkEmbedding);
        } catch (error) {
          // If embedding parsing fails, use 0 similarity
          similarity = 0;
        }
        
        return {
          chunk_id: chunk.chunk_id,
          doc_id: chunk.doc_id,
          idx: chunk.idx,
          score: similarity,
          preview: chunk.text.substring(0, 240) + (chunk.text.length > 240 ? '...' : ''),
          text: chunk.text,
          title: chunk.title,
          start_off: chunk.start_off,
          end_off: chunk.end_off
        };
      });

      // Sort by similarity (descending) and take top K
      return similarities
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } catch (error) {
      throw new Error(`Vector search failed: ${error}`);
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async getChunk(chunkId: string): Promise<VecChunk | null> {
    try {
      const db = this.connect();
      const stmt = db.prepare(`
        SELECT chunk_id, doc_id, idx, start_off, end_off, text
        FROM vec_chunks 
        WHERE chunk_id = ?
      `);
      
      const result = stmt.get(chunkId) as VecChunk | undefined;
      return result || null;
    } catch (error) {
      throw new Error(`Get chunk failed: ${error}`);
    }
  }

  async getDocuments(limit: number = 50, offset: number = 0): Promise<{ documents: Document[]; hasMore: boolean }> {
    try {
      const db = this.connect();
      const stmt = db.prepare(`
        SELECT * FROM documents 
        ORDER BY updated_at DESC 
        LIMIT ? OFFSET ?
      `);
      
      const documents = stmt.all(limit + 1, offset) as Document[];
      const hasMore = documents.length > limit;
      
      if (hasMore) {
        documents.pop(); // Remove the extra document used for hasMore check
      }
      
      return { documents, hasMore };
    } catch (error) {
      throw new Error(`Get documents failed: ${error}`);
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
