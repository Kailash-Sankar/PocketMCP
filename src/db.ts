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
  content_type: string;
  size_bytes: number;
  content_sha256: string;
  mtime: string;
  ingest_status: 'ok' | 'skipped' | 'needs_ocr' | 'too_large' | 'error';
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface Segment {
  segment_id: string;
  doc_id: string;
  kind: 'page' | 'section';
  page?: number;
  meta?: Record<string, any>;
  text: string;
}

export interface VecChunk {
  chunk_id: string;
  segment_id: string;
  start_char: number;
  end_char: number;
  text: string;
  embedding: Float32Array;
}

export interface SearchResult {
  chunk_id: string;
  segment_id: string;
  doc_id: string;
  score: number;
  preview: string;
  text: string;
  title?: string;
  source_badge?: string;
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
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        mtime TEXT NOT NULL,
        ingest_status TEXT NOT NULL DEFAULT 'ok',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Create segments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segments (
        segment_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        page INTEGER,
        meta TEXT,
        text TEXT NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_external_id ON documents(external_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(ingest_status);
      CREATE INDEX IF NOT EXISTS idx_segments_doc_id ON segments(doc_id);
    `);

    // For now, use regular table until we properly configure vec0
    // TODO: Fix vec0 virtual table configuration
    console.log('Using regular table with JSON embeddings for now');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_chunks (
        chunk_id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        embedding TEXT,
        text TEXT NOT NULL,
        FOREIGN KEY (segment_id) REFERENCES segments(segment_id) ON DELETE CASCADE
      );
    `);
    this.useVectorTable = false;

    // Create index on segment_id for fast deletions (only for regular tables)
    if (!this.useVectorTable) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_vec_chunks_segment_id ON vec_chunks(segment_id);
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
      (doc_id, external_id, source, uri, title, content_type, size_bytes, content_sha256, mtime, ingest_status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      fullDoc.doc_id,
      fullDoc.external_id,
      fullDoc.source,
      fullDoc.uri,
      fullDoc.title,
      fullDoc.content_type,
      fullDoc.size_bytes,
      fullDoc.content_sha256,
      fullDoc.mtime,
      fullDoc.ingest_status,
      fullDoc.notes || null,
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
      // Count chunks before deletion (via segments)
      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM vec_chunks vc 
        JOIN segments s ON vc.segment_id = s.segment_id 
        WHERE s.doc_id = ?
      `);
      const { count } = countStmt.get(docId) as { count: number };

      // Delete chunks (will cascade from segments)
      const deleteChunksStmt = this.db.prepare(`
        DELETE FROM vec_chunks 
        WHERE segment_id IN (
          SELECT segment_id FROM segments WHERE doc_id = ?
        )
      `);
      deleteChunksStmt.run(docId);

      // Delete segments
      const deleteSegmentsStmt = this.db.prepare('DELETE FROM segments WHERE doc_id = ?');
      deleteSegmentsStmt.run(docId);

      // Delete document
      const deleteDocStmt = this.db.prepare('DELETE FROM documents WHERE doc_id = ?');
      deleteDocStmt.run(docId);

      return { deletedChunks: count };
    });

    return transaction();
  }

  // Segment operations
  upsertSegment(segment: Segment): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO segments 
      (segment_id, doc_id, kind, page, meta, text)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      segment.segment_id,
      segment.doc_id,
      segment.kind,
      segment.page || null,
      segment.meta ? JSON.stringify(segment.meta) : null,
      segment.text
    );
  }

  getSegmentsByDocId(docId: string): Segment[] {
    const stmt = this.db.prepare('SELECT * FROM segments WHERE doc_id = ? ORDER BY segment_id');
    const results = stmt.all(docId) as any[];
    
    return results.map(row => ({
      ...row,
      meta: row.meta ? JSON.parse(row.meta) : undefined
    }));
  }

  replaceDocumentSegments(docId: string, segments: Segment[]): void {
    const transaction = this.db.transaction(() => {
      // Delete existing segments and their chunks
      this.db.prepare(`
        DELETE FROM vec_chunks 
        WHERE segment_id IN (
          SELECT segment_id FROM segments WHERE doc_id = ?
        )
      `).run(docId);
      
      this.db.prepare('DELETE FROM segments WHERE doc_id = ?').run(docId);

      // Insert new segments
      const insertStmt = this.db.prepare(`
        INSERT INTO segments (segment_id, doc_id, kind, page, meta, text)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const segment of segments) {
        insertStmt.run(
          segment.segment_id,
          segment.doc_id,
          segment.kind,
          segment.page || null,
          segment.meta ? JSON.stringify(segment.meta) : null,
          segment.text
        );
      }
    });

    transaction();
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
        INSERT INTO vec_chunks (chunk_id, segment_id, start_char, end_char, embedding, text)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = `${chunk.segment_id}_${i}`;
        const embeddingData = this.useVectorTable 
          ? Array.from(chunk.embedding)
          : JSON.stringify(Array.from(chunk.embedding));
        
        stmt.run(
          chunkId,
          chunk.segment_id,
          chunk.start_char,
          chunk.end_char,
          embeddingData,
          chunk.text
        );
      }
    });

    transaction();
  }

  replaceSegmentChunks(segmentId: string, chunks: Omit<VecChunk, 'chunk_id'>[]): void {
    const transaction = this.db.transaction(() => {
      // Delete existing chunks for this segment
      const deleteStmt = this.db.prepare('DELETE FROM vec_chunks WHERE segment_id = ?');
      deleteStmt.run(segmentId);

      // Insert new chunks
      const insertStmt = this.db.prepare(`
        INSERT INTO vec_chunks (chunk_id, segment_id, start_char, end_char, embedding, text)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = `${segmentId}_${i}`;
        const embeddingData = this.useVectorTable 
          ? Array.from(chunk.embedding)
          : JSON.stringify(Array.from(chunk.embedding));
        
        insertStmt.run(
          chunkId,
          segmentId,
          chunk.start_char,
          chunk.end_char,
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
          vc.chunk_id,
          vc.segment_id,
          s.doc_id,
          s.kind,
          s.page,
          s.meta,
          vc.text,
          d.title,
          d.content_type,
          (1 - distance) as score
        FROM vec_chunks vc
        JOIN segments s ON vc.segment_id = s.segment_id
        LEFT JOIN documents d ON s.doc_id = d.doc_id
        WHERE vc.embedding MATCH ?
      `;

      const params: any[] = [Array.from(queryEmbedding)];

      if (docIds && docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',');
        query += ` AND s.doc_id IN (${placeholders})`;
        params.push(...docIds);
      }

      query += ` ORDER BY distance ASC LIMIT ?`;
      params.push(topK);

      const stmt = this.db.prepare(query);
      const results = stmt.all(...params) as any[];

      return results.map(row => ({
        chunk_id: row.chunk_id,
        segment_id: row.segment_id,
        doc_id: row.doc_id,
        score: Math.max(0, Math.min(1, row.score)), // Clamp between 0 and 1
        preview: row.text.substring(0, 240) + (row.text.length > 240 ? '...' : ''),
        text: row.text,
        title: row.title,
        source_badge: this.generateSourceBadge(row.title, row.content_type, row.kind, row.page, row.meta)
      }));
    } else {
      // Fallback: load all embeddings and compute similarity in memory
      console.warn('Using fallback similarity search (slower for large datasets)');
      
      let query = `
        SELECT 
          vc.chunk_id,
          vc.segment_id,
          s.doc_id,
          s.kind,
          s.page,
          s.meta,
          vc.text,
          vc.embedding,
          d.title,
          d.content_type
        FROM vec_chunks vc
        JOIN segments s ON vc.segment_id = s.segment_id
        LEFT JOIN documents d ON s.doc_id = d.doc_id
      `;

      const params: any[] = [];

      if (docIds && docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',');
        query += ` WHERE s.doc_id IN (${placeholders})`;
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
          segment_id: chunk.segment_id,
          doc_id: chunk.doc_id,
          score: similarity,
          preview: chunk.text.substring(0, 240) + (chunk.text.length > 240 ? '...' : ''),
          text: chunk.text,
          title: chunk.title,
          source_badge: this.generateSourceBadge(chunk.title, chunk.content_type, chunk.kind, chunk.page, chunk.meta)
        };
      });

      // Sort by similarity (descending) and take top K
      return similarities
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }
  }

  private generateSourceBadge(title: string, contentType: string, kind: string, page?: number, meta?: string): string {
    const fileName = title || 'Unknown';
    
    if (contentType === 'application/pdf' && kind === 'page' && page) {
      return `${fileName} · p.${page}`;
    }
    
    if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      if (meta) {
        try {
          const metaObj = JSON.parse(meta);
          if (metaObj.heading) {
            return `${fileName} · § ${metaObj.heading}`;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
      return fileName;
    }
    
    return fileName;
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
      SELECT chunk_id, segment_id, start_char, end_char, text, embedding
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
