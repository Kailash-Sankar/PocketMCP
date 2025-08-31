import { DatabaseManager, Document, Segment } from './db.js';
import { EmbeddingManager } from './embeddings.js';
import { TextChunker, TextChunk } from './chunker.js';
import { createHash } from 'crypto';

export interface IngestDocument {
  text?: string; // Optional since we might have segments instead
  segments?: Segment[]; // Pre-segmented content
  external_id?: string;
  title?: string;
  source?: 'file' | 'url' | 'raw';
  uri?: string;
  content_type?: string;
  size_bytes?: number;
  mtime?: string;
  ingest_status?: 'ok' | 'skipped' | 'needs_ocr' | 'too_large' | 'error';
  notes?: string;
  metadata?: Record<string, any>;
}

export interface IngestResult {
  doc_id: string;
  chunks: number;
  status: 'inserted' | 'updated' | 'skipped';
  external_id?: string;
}

export interface IngestOptions {
  skipIfUnchanged?: boolean;
  batchSize?: number;
}

export class IngestManager {
  private db: DatabaseManager;
  private embeddings: EmbeddingManager;
  private chunker: TextChunker;

  constructor(
    db: DatabaseManager, 
    embeddings: EmbeddingManager, 
    chunker: TextChunker
  ) {
    this.db = db;
    this.embeddings = embeddings;
    this.chunker = chunker;
  }

  async ingestSingle(
    doc: IngestDocument, 
    options: IngestOptions = {}
  ): Promise<IngestResult> {
    const results = await this.ingestBatch([doc], options);
    return results[0];
  }

  async ingestBatch(
    docs: IngestDocument[], 
    options: IngestOptions = {}
  ): Promise<IngestResult[]> {
    if (docs.length === 0) {
      return [];
    }

    const results: IngestResult[] = [];
    const { skipIfUnchanged = true, batchSize = 10 } = options;

    // Process in batches to manage memory
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      const batchResults = await this.processBatch(batch, skipIfUnchanged);
      results.push(...batchResults);
    }

    return results;
  }

  private async processBatch(
    docs: IngestDocument[], 
    skipIfUnchanged: boolean
  ): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    
    // Prepare documents and check for changes
    const docsToProcess: Array<{
      doc: IngestDocument;
      docId: string;
      contentHash: string;
      status: 'insert' | 'update' | 'skip';
      existingDoc?: Document | null;
    }> = [];

    for (const doc of docs) {
      // Calculate content hash from either text or segments
      const contentForHash = doc.text || (doc.segments ? doc.segments.map(s => s.text).join('\n') : '');
      const contentHash = this.hashContent(contentForHash);
      const docId = this.generateDocId(doc);
      
      let status: 'insert' | 'update' | 'skip' = 'insert';
      let existingDoc: Document | null = null;

      if (doc.external_id) {
        existingDoc = this.db.getDocumentByExternalId(doc.external_id);
        if (existingDoc) {
          if (skipIfUnchanged && existingDoc.content_sha256 === contentHash) {
            status = 'skip';
          } else {
            status = 'update';
          }
        }
      }

      docsToProcess.push({
        doc,
        docId: existingDoc?.doc_id || docId,
        contentHash,
        status,
        existingDoc
      });
    }

    // Filter out skipped documents
    const activeProcessing = docsToProcess.filter(item => item.status !== 'skip');
    
    // Add skipped results
    docsToProcess
      .filter(item => item.status === 'skip')
      .forEach(item => {
        results.push({
          doc_id: item.docId,
          chunks: 0, // We don't count existing chunks for skipped docs
          status: 'skipped',
          external_id: item.doc.external_id
        });
      });

    if (activeProcessing.length === 0) {
      return results;
    }

    // Process segments and chunk them
    console.log(`Processing ${activeProcessing.length} documents...`);
    const allDocData: Array<{
      docId: string;
      segments: Segment[];
      segmentChunks: Array<{ segmentId: string; chunks: TextChunk[] }>;
      doc: IngestDocument;
      status: 'insert' | 'update';
    }> = [];

    for (const item of activeProcessing) {
      const doc = item.doc;
      let segments: Segment[];

      if (doc.segments) {
        // Use pre-segmented content
        segments = doc.segments.map(seg => ({
          ...seg,
          doc_id: item.docId
        }));
      } else if (doc.text) {
        // Create single segment from text
        segments = [{
          segment_id: `${item.docId}_text`,
          doc_id: item.docId,
          kind: 'section' as const,
          text: doc.text
        }];
      } else {
        console.warn(`Document ${item.docId} has no text or segments, skipping`);
        continue;
      }

      // Chunk each segment
      const segmentChunks = segments.map(segment => ({
        segmentId: segment.segment_id,
        chunks: this.chunker.chunkText(segment.text)
      }));

      allDocData.push({
        docId: item.docId,
        segments,
        segmentChunks,
        doc: item.doc,
        status: item.status as 'insert' | 'update'
      });
    }

    // Collect all chunk texts for batch embedding
    const allChunkTexts: string[] = [];
    const chunkMapping: Array<{ docIndex: number; segmentIndex: number; chunkIndex: number }> = [];

    allDocData.forEach((docData, docIndex) => {
      docData.segmentChunks.forEach((segmentData, segmentIndex) => {
        segmentData.chunks.forEach((chunk, chunkIndex) => {
          allChunkTexts.push(chunk.text);
          chunkMapping.push({ docIndex, segmentIndex, chunkIndex });
        });
      });
    });

    // Generate embeddings in batch
    console.log(`Generating embeddings for ${allChunkTexts.length} chunks...`);
    const embeddings = await this.embeddings.embedBatch(allChunkTexts);

    // Assign embeddings back to chunks
    embeddings.forEach((embedding, embeddingIndex) => {
      const mapping = chunkMapping[embeddingIndex];
      const docData = allDocData[mapping.docIndex];
      const segmentData = docData.segmentChunks[mapping.segmentIndex];
      const chunk = segmentData.chunks[mapping.chunkIndex];
      (chunk as any).embedding = embedding;
    });

    // Store everything in database
    console.log(`Storing ${allDocData.length} documents in database...`);
    for (let i = 0; i < allDocData.length; i++) {
      const { docId, segments, segmentChunks, doc, status } = allDocData[i];
      const { contentHash } = activeProcessing[i];

      try {
        // Prepare document record
        const docRecord: Document = {
          doc_id: docId,
          external_id: doc.external_id || docId,
          source: doc.source || 'raw',
          uri: doc.uri || `raw://${docId}`,
          title: doc.title || 'Untitled',
          content_type: doc.content_type || 'text/plain',
          size_bytes: doc.size_bytes || 0,
          content_sha256: contentHash,
          mtime: doc.mtime || new Date().toISOString(),
          ingest_status: doc.ingest_status || 'ok',
          notes: doc.notes,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        // Store document
        this.db.upsertDocument(docRecord);

        // Store segments
        this.db.replaceDocumentSegments(docId, segments);

        // Store chunks for each segment
        let totalChunks = 0;
        for (let j = 0; j < segmentChunks.length; j++) {
          const { segmentId, chunks } = segmentChunks[j];
          
          const chunkRecords = chunks.map((chunk, idx) => ({
            segment_id: segmentId,
            start_char: chunk.startOffset,
            end_char: chunk.endOffset,
            text: chunk.text,
            embedding: (chunk as any).embedding as Float32Array
          }));

          this.db.replaceSegmentChunks(segmentId, chunkRecords);
          totalChunks += chunks.length;
        }

        results.push({
          doc_id: docId,
          chunks: totalChunks,
          status: status === 'insert' ? 'inserted' : 'updated',
          external_id: doc.external_id
        });

        console.log(`${status === 'insert' ? 'Inserted' : 'Updated'} document ${docId} with ${segments.length} segments and ${totalChunks} chunks`);
      } catch (error) {
        console.error(`Failed to store document ${docId}:`, error);
        throw error;
      }
    }

    return results;
  }

  async deleteDocuments(docIds?: string[], externalIds?: string[]): Promise<{
    deletedDocIds: string[];
    deletedChunks: number;
  }> {
    const deletedDocIds: string[] = [];
    let totalDeletedChunks = 0;

    // Handle deletion by external IDs
    if (externalIds && externalIds.length > 0) {
      for (const externalId of externalIds) {
        const doc = this.db.getDocumentByExternalId(externalId);
        if (doc) {
          const result = this.db.deleteDocument(doc.doc_id);
          deletedDocIds.push(doc.doc_id);
          totalDeletedChunks += result.deletedChunks;
        }
      }
    }

    // Handle deletion by doc IDs
    if (docIds && docIds.length > 0) {
      for (const docId of docIds) {
        const result = this.db.deleteDocument(docId);
        if (result.deletedChunks > 0) {
          deletedDocIds.push(docId);
          totalDeletedChunks += result.deletedChunks;
        }
      }
    }

    return {
      deletedDocIds,
      deletedChunks: totalDeletedChunks
    };
  }

  private generateDocId(doc: IngestDocument): string {
    if (doc.external_id) {
      return `doc_${this.hashContent(doc.external_id).substring(0, 16)}`;
    }
    
    // Generate based on content hash and timestamp
    const contentForHash = doc.text || (doc.segments ? doc.segments.map(s => s.text).join('\n') : '');
    const contentHash = this.hashContent(contentForHash);
    const timestamp = Date.now().toString(36);
    return `doc_${contentHash.substring(0, 12)}_${timestamp}`;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Utility methods
  async search(
    query: string, 
    topK: number = 8, 
    docIds?: string[]
  ): Promise<Array<{
    chunk_id: string;
    doc_id: string;
    score: number;
    preview: string;
    resource: string;
  }>> {
    // Generate query embedding
    const queryEmbedding = await this.embeddings.embedSingle(query);
    
    // Search in database
    const results = this.db.searchSimilar(queryEmbedding, topK, docIds);
    
    // Format results with resource URIs
    return results.map(result => ({
      chunk_id: result.chunk_id,
      doc_id: result.doc_id,
      score: result.score,
      preview: result.preview,
      resource: `mcp+doc://${result.doc_id}#${result.chunk_id}`
    }));
  }

  getStats(): {
    totalDocuments: number;
    totalChunks: number;
  } {
    const documents = this.db.listDocuments(1000000); // Get all docs
    const totalDocuments = documents.length;
    
    // This is a rough estimate - in production you might want to cache this
    // or add a proper count query
    let totalChunks = 0;
    try {
      const result = this.db['db'].prepare('SELECT COUNT(*) as count FROM vec_chunks').get() as { count: number };
      totalChunks = result.count;
    } catch {
      // Fallback - this shouldn't happen with proper schema
      totalChunks = 0;
    }

    return { totalDocuments, totalChunks };
  }
}
