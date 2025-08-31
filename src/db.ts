import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { load as loadSqliteVec } from 'sqlite-vec';

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
  embedding: Float32Array;
}

export interface SearchResult {
  chunk_id: string;
  doc_id: string;
  idx: number;
  score: number;
  preview: string;
  text: string;
  title?: string;
}

export class DatabaseManager {
  private db: Database.Database;
  private useVectorTable: boolean = false;

  constructor(sqlitePath: string) {
    // Ensure directory exists
    const dir = dirname(resolve(sqlitePath));
    mkdirSync(dir, { recursive: true });

    this.db = new Database(sqlitePath);
    
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    
    this.loadSqliteVec();
    this.initSchema();
  }

  private loadSqliteVec() {
    let loaded = false;
    let lastError: any = null;

    try {
      loadSqliteVec(this.db);
      loaded = true;
      console.log('Successfully loaded sqlite-vec extension');
    } catch (error) {
      lastError = error;
    }

    if (!loaded) {
      console.error('Failed to load sqlite-vec extension:', lastError);
      console.warn('WARNING: Running without sqlite-vec extension. Vector search will not work.');
    }
  }

  private initSchema() {
    // Create documents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        external_id TEXT UNIQUE,
        source TEXT NOT NULL,
        uri TEXT NOT NULL,
        title TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Create index on external_id for fast lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_external_id ON documents(external_id);
    `);

    // For now, use regular table until we properly configure vec0
    // TODO: Fix vec0 virtual table configuration
    console.log('Using regular table with JSON embeddings for now');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT,
        idx INTEGER,
        start_off INTEGER,
        end_off INTEGER,
        embedding TEXT,
        text TEXT
      );
    `);
    this.useVectorTable = false;

    // Create index on doc_id for fast deletions (only for regular tables)
    if (!this.useVectorTable) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_vec_chunks_doc_id ON vec_chunks(doc_id);
      `);
    }
  }

  // Document operations
  upsertDocument(doc: Omit<Document, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }): Document {
    const now = new Date().toISOString();
    const fullDoc: Document = {
      ...doc,
      created_at: doc.created_at || now,
      updated_at: doc.updated_at || now,
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents 
      (doc_id, external_id, source, uri, title, content_sha256, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      fullDoc.doc_id,
      fullDoc.external_id,
      fullDoc.source,
      fullDoc.uri,
      fullDoc.title,
      fullDoc.content_sha256,
      fullDoc.created_at,
      fullDoc.updated_at
    );

    return fullDoc;
  }

  getDocument(docId: string): Document | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE doc_id = ?');
    return stmt.get(docId) as Document | null;
  }

  getDocumentByExternalId(externalId: string): Document | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE external_id = ?');
    return stmt.get(externalId) as Document | null;
  }

  deleteDocument(docId: string): { deletedChunks: number } {
    const transaction = this.db.transaction(() => {
      // Count chunks before deletion
      const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM vec_chunks WHERE doc_id = ?');
      const { count } = countStmt.get(docId) as { count: number };

      // Delete chunks
      const deleteChunksStmt = this.db.prepare('DELETE FROM vec_chunks WHERE doc_id = ?');
      deleteChunksStmt.run(docId);

      // Delete document
      const deleteDocStmt = this.db.prepare('DELETE FROM documents WHERE doc_id = ?');
      deleteDocStmt.run(docId);

      return { deletedChunks: count };
    });

    return transaction();
  }

  listDocuments(limit: number = 50, offset: number = 0): Document[] {
    const stmt = this.db.prepare(`
      SELECT * FROM documents 
      ORDER BY updated_at DESC 
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset) as Document[];
  }

  // Vector chunk operations
  insertChunks(chunks: Omit<VecChunk, 'chunk_id'>[]): void {
    const transaction = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO vec_chunks (chunk_id, doc_id, idx, start_off, end_off, embedding, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        const chunkId = `${chunk.doc_id}_${chunk.idx}`;
        const embeddingData = this.useVectorTable 
          ? Array.from(chunk.embedding)
          : JSON.stringify(Array.from(chunk.embedding));
        
        stmt.run(
          chunkId,
          chunk.doc_id,
          chunk.idx,
          chunk.start_off,
          chunk.end_off,
          embeddingData,
          chunk.text
        );
      }
    });

    transaction();
  }

  replaceDocumentChunks(docId: string, chunks: Omit<VecChunk, 'chunk_id'>[]): void {
    const transaction = this.db.transaction(() => {
      // Delete existing chunks
      const deleteStmt = this.db.prepare('DELETE FROM vec_chunks WHERE doc_id = ?');
      deleteStmt.run(docId);

      // Insert new chunks
      const insertStmt = this.db.prepare(`
        INSERT INTO vec_chunks (chunk_id, doc_id, idx, start_off, end_off, embedding, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        const chunkId = `${docId}_${chunk.idx}`;
        const embeddingData = this.useVectorTable 
          ? Array.from(chunk.embedding)
          : JSON.stringify(Array.from(chunk.embedding));
        
        insertStmt.run(
          chunkId,
          docId,
          chunk.idx,
          chunk.start_off,
          chunk.end_off,
          embeddingData,
          chunk.text
        );
      }
    });

    transaction();
  }

  searchSimilar(queryEmbedding: Float32Array, topK: number = 8, docIds?: string[]): SearchResult[] {
    if (this.useVectorTable) {
      // Use sqlite-vec for efficient vector search
      let query = `
        SELECT 
          vec_chunks.chunk_id,
          vec_chunks.doc_id,
          vec_chunks.idx,
          vec_chunks.start_off,
          vec_chunks.end_off,
          vec_chunks.text,
          documents.title,
          (1 - distance) as score
        FROM vec_chunks
        LEFT JOIN documents ON vec_chunks.doc_id = documents.doc_id
        WHERE vec_chunks.embedding MATCH ?
      `;

      const params: any[] = [Array.from(queryEmbedding)];

      if (docIds && docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',');
        query += ` AND vec_chunks.doc_id IN (${placeholders})`;
        params.push(...docIds);
      }

      query += ` ORDER BY distance ASC LIMIT ?`;
      params.push(topK);

      const stmt = this.db.prepare(query);
      const results = stmt.all(...params) as any[];

      return results.map(row => ({
        chunk_id: row.chunk_id,
        doc_id: row.doc_id,
        idx: row.idx,
        score: Math.max(0, Math.min(1, row.score)), // Clamp between 0 and 1
        preview: row.text.substring(0, 240) + (row.text.length > 240 ? '...' : ''),
        text: row.text,
        title: row.title
      }));
    } else {
      // Fallback: load all embeddings and compute similarity in memory
      console.warn('Using fallback similarity search (slower for large datasets)');
      
      let query = `
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
      `;

      const params: any[] = [];

      if (docIds && docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',');
        query += ` WHERE vec_chunks.doc_id IN (${placeholders})`;
        params.push(...docIds);
      }

      const stmt = this.db.prepare(query);
      const allChunks = stmt.all(...params) as any[];

      // Compute cosine similarity for each chunk
      const similarities = allChunks.map(chunk => {
        const chunkEmbedding = new Float32Array(JSON.parse(chunk.embedding));
        const similarity = this.cosineSimilarity(queryEmbedding, chunkEmbedding);
        
        return {
          chunk_id: chunk.chunk_id,
          doc_id: chunk.doc_id,
          idx: chunk.idx,
          score: similarity,
          preview: chunk.text.substring(0, 240) + (chunk.text.length > 240 ? '...' : ''),
          text: chunk.text,
          title: chunk.title
        };
      });

      // Sort by similarity (descending) and take top K
      return similarities
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
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

  getChunk(chunkId: string): VecChunk | null {
    const stmt = this.db.prepare(`
      SELECT chunk_id, doc_id, idx, start_off, end_off, text, embedding
      FROM vec_chunks 
      WHERE chunk_id = ?
    `);
    const result = stmt.get(chunkId) as any;
    
    if (!result) return null;

    return {
      ...result,
      embedding: this.useVectorTable 
        ? new Float32Array(result.embedding)
        : new Float32Array(JSON.parse(result.embedding))
    };
  }

  close(): void {
    this.db.close();
  }

  // Health check
  isHealthy(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
}
