import { DatabaseManager, Document } from './db.js';
import { EmbeddingManager } from './embeddings.js';
import { TextChunker, TextChunk } from './chunker.js';
import { createHash } from 'crypto';

export interface IngestDocument {
  text: string;
  external_id?: string;
  title?: string;
  source?: 'file' | 'url' | 'raw';
  uri?: string;
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
      const contentHash = this.hashContent(doc.text);
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

    // Chunk all texts
    console.log(`Chunking ${activeProcessing.length} documents...`);
    const allChunkData: Array<{
      docId: string;
      chunks: TextChunk[];
      doc: IngestDocument;
      status: 'insert' | 'update';
    }> = activeProcessing.map(item => ({
      docId: item.docId,
      chunks: this.chunker.chunkText(item.doc.text),
      doc: item.doc,
      status: item.status as 'insert' | 'update'
    }));

    // Collect all chunk texts for batch embedding
    const allChunkTexts: string[] = [];
    const chunkMapping: Array<{ docIndex: number; chunkIndex: number }> = [];

    allChunkData.forEach((docData, docIndex) => {
      docData.chunks.forEach((chunk, chunkIndex) => {
        allChunkTexts.push(chunk.text);
        chunkMapping.push({ docIndex, chunkIndex });
      });
    });

    // Generate embeddings in batch
    console.log(`Generating embeddings for ${allChunkTexts.length} chunks...`);
    const embeddings = await this.embeddings.embedBatch(allChunkTexts);

    // Assign embeddings back to chunks
    embeddings.forEach((embedding, embeddingIndex) => {
      const mapping = chunkMapping[embeddingIndex];
      const docData = allChunkData[mapping.docIndex];
      const chunk = docData.chunks[mapping.chunkIndex];
      (chunk as any).embedding = embedding;
    });

    // Store everything in database
    console.log(`Storing ${activeProcessing.length} documents in database...`);
    for (let i = 0; i < allChunkData.length; i++) {
      const { docId, chunks, doc, status } = allChunkData[i];
      const { contentHash } = activeProcessing[i];

      try {
        // Prepare document record
        const docRecord: Document = {
          doc_id: docId,
          external_id: doc.external_id || docId,
          source: doc.source || 'raw',
          uri: doc.uri || `raw://${docId}`,
          title: doc.title || 'Untitled',
          content_sha256: contentHash,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        // Prepare chunk records
        const chunkRecords = chunks.map((chunk, idx) => ({
          doc_id: docId,
          idx,
          start_off: chunk.startOffset,
          end_off: chunk.endOffset,
          text: chunk.text,
          embedding: (chunk as any).embedding as Float32Array
        }));

        // Store in database (this handles the transaction)
        this.db.upsertDocument(docRecord);
        this.db.replaceDocumentChunks(docId, chunkRecords);

        results.push({
          doc_id: docId,
          chunks: chunks.length,
          status: status === 'insert' ? 'inserted' : 'updated',
          external_id: doc.external_id
        });

        console.log(`${status === 'insert' ? 'Inserted' : 'Updated'} document ${docId} with ${chunks.length} chunks`);
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
    const contentHash = this.hashContent(doc.text);
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
    idx: number;
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
      idx: result.idx,
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
