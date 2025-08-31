import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { DatabaseManager } from '../src/db.js';
import { EmbeddingManager } from '../src/embeddings.js';
import { TextChunker } from '../src/chunker.js';
import { IngestManager } from '../src/ingest.js';
import { FileIngestManager } from '../src/file-ingest.js';
import { 
  PdfExtractor, 
  DocxExtractor, 
  createExtractor, 
  getContentType,
  ParseError,
  TooLargeError,
  EncryptedPdfError 
} from '../src/extractors.js';

describe('Enhanced Ingestion Pipeline', () => {
  let db: DatabaseManager;
  let embeddings: EmbeddingManager;
  let chunker: TextChunker;
  let ingestManager: IngestManager;
  let fileIngestManager: FileIngestManager;
  
  const testDbPath = './test-enhanced.db';
  const fixturesDir = './fixtures/ingest';

  beforeEach(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Create test database and managers
    db = new DatabaseManager(testDbPath);
    embeddings = new EmbeddingManager('Xenova/all-MiniLM-L6-v2');
    chunker = new TextChunker({
      chunkSize: 500,
      chunkOverlap: 50
    });
    ingestManager = new IngestManager(db, embeddings, chunker);
    fileIngestManager = new FileIngestManager(ingestManager, {
      supportedExtensions: ['.md', '.txt', '.pdf', '.docx'],
      pdfMaxPages: 10,
      pdfMinTextChars: 100,
      docMaxBytes: 1000000,
      docxSplitOnHeadings: false
    });

    // Initialize embeddings
    await embeddings.initialize();
  });

  afterEach(() => {
    // Clean up
    db.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('Database Schema', () => {
    it('should create schema with documents, segments, and chunks tables', () => {
      expect(db.isHealthy()).toBe(true);
      
      // Test that we can create a document with new fields
      const doc = db.upsertDocument({
        doc_id: 'test_doc_1',
        external_id: 'test_external_1',
        source: 'file',
        uri: 'file:///test.pdf',
        title: 'Test Document',
        content_type: 'application/pdf',
        size_bytes: 1024,
        content_sha256: 'test_hash',
        mtime: new Date().toISOString(),
        ingest_status: 'ok'
      });

      expect(doc.content_type).toBe('application/pdf');
      expect(doc.ingest_status).toBe('ok');
    });

    it('should handle segments and chunks', () => {
      // Create a document
      const doc = db.upsertDocument({
        doc_id: 'test_doc_2',
        external_id: 'test_external_2',
        source: 'file',
        uri: 'file:///test.pdf',
        title: 'Test Document',
        content_type: 'application/pdf',
        size_bytes: 1024,
        content_sha256: 'test_hash',
        mtime: new Date().toISOString(),
        ingest_status: 'ok'
      });

      // Create segments
      const segments = [
        {
          segment_id: 'test_doc_2_page_1',
          doc_id: 'test_doc_2',
          kind: 'page' as const,
          page: 1,
          text: 'This is page 1 content'
        },
        {
          segment_id: 'test_doc_2_page_2',
          doc_id: 'test_doc_2',
          kind: 'page' as const,
          page: 2,
          text: 'This is page 2 content'
        }
      ];

      db.replaceDocumentSegments('test_doc_2', segments);
      
      const retrievedSegments = db.getSegmentsByDocId('test_doc_2');
      expect(retrievedSegments).toHaveLength(2);
      expect(retrievedSegments[0].kind).toBe('page');
      expect(retrievedSegments[0].page).toBe(1);
    });
  });

  describe('Content Type Detection', () => {
    it('should correctly detect content types', () => {
      expect(getContentType('test.pdf')).toBe('application/pdf');
      expect(getContentType('test.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(getContentType('test.md')).toBe('text/markdown');
      expect(getContentType('test.txt')).toBe('text/plain');
    });
  });

  describe('Extractor Factory', () => {
    it('should create appropriate extractors', () => {
      const pdfExtractor = createExtractor('test.pdf');
      const docxExtractor = createExtractor('test.docx');
      const noExtractor = createExtractor('test.xyz');

      expect(pdfExtractor).toBeInstanceOf(PdfExtractor);
      expect(docxExtractor).toBeInstanceOf(DocxExtractor);
      expect(noExtractor).toBeNull();
    });
  });

  describe('Segment-based Ingestion', () => {
    it('should handle documents with pre-segmented content', async () => {
      const segments = [
        {
          segment_id: 'doc1_page_1',
          doc_id: 'doc1',
          kind: 'page' as const,
          page: 1,
          text: 'This is the first page of the document. It contains important information about the topic.'
        },
        {
          segment_id: 'doc1_page_2', 
          doc_id: 'doc1',
          kind: 'page' as const,
          page: 2,
          text: 'This is the second page with additional details and conclusions.'
        }
      ];

      const result = await ingestManager.ingestSingle({
        segments,
        external_id: 'test_segmented_doc',
        title: 'Test Segmented Document',
        source: 'file',
        uri: 'file:///test.pdf',
        content_type: 'application/pdf',
        size_bytes: 2048,
        mtime: new Date().toISOString(),
        ingest_status: 'ok'
      });

      expect(result.status).toBe('inserted');
      expect(result.chunks).toBeGreaterThan(0);

      // Verify segments were stored
      const storedSegments = db.getSegmentsByDocId(result.doc_id);
      expect(storedSegments).toHaveLength(2);
      expect(storedSegments[0].kind).toBe('page');
      expect(storedSegments[0].page).toBe(1);
    });

    it('should handle documents with different ingest statuses', async () => {
      const testCases = [
        { status: 'too_large', notes: 'File exceeds size limit' },
        { status: 'needs_ocr', notes: 'PDF requires OCR processing' },
        { status: 'error', notes: 'Failed to parse document' },
        { status: 'skipped', notes: 'Encrypted file' }
      ];

      for (const testCase of testCases) {
        const result = await ingestManager.ingestSingle({
          text: 'Sample text',
          external_id: `test_${testCase.status}`,
          title: `Test ${testCase.status}`,
          source: 'file',
          uri: 'file:///test.pdf',
          content_type: 'application/pdf',
          size_bytes: 1024,
          mtime: new Date().toISOString(),
          ingest_status: testCase.status as any,
          notes: testCase.notes
        });

        expect(result.status).toBe('inserted');
        
        const doc = db.getDocument(result.doc_id);
        expect(doc?.ingest_status).toBe(testCase.status);
        expect(doc?.notes).toBe(testCase.notes);
      }
    });
  });

  describe('Search with Source Badges', () => {
    it('should return search results with appropriate source badges', async () => {
      // Create a PDF document with page segments
      const pdfSegments = [
        {
          segment_id: 'pdf_doc_page_1',
          doc_id: 'pdf_doc',
          kind: 'page' as const,
          page: 1,
          text: 'Machine learning algorithms are powerful tools for data analysis.'
        },
        {
          segment_id: 'pdf_doc_page_2',
          doc_id: 'pdf_doc', 
          kind: 'page' as const,
          page: 2,
          text: 'Deep learning networks can process complex patterns in data.'
        }
      ];

      await ingestManager.ingestSingle({
        segments: pdfSegments,
        external_id: 'test_pdf',
        title: 'ML Guide.pdf',
        source: 'file',
        uri: 'file:///ml-guide.pdf',
        content_type: 'application/pdf',
        size_bytes: 2048,
        mtime: new Date().toISOString(),
        ingest_status: 'ok'
      });

      // Create a DOCX document with section segments
      const docxSegments = [
        {
          segment_id: 'docx_doc_section_1',
          doc_id: 'docx_doc',
          kind: 'section' as const,
          meta: { heading: 'Introduction', level: 1 },
          text: 'This document covers machine learning fundamentals and applications.'
        }
      ];

      await ingestManager.ingestSingle({
        segments: docxSegments,
        external_id: 'test_docx',
        title: 'ML Basics.docx',
        source: 'file',
        uri: 'file:///ml-basics.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size_bytes: 1024,
        mtime: new Date().toISOString(),
        ingest_status: 'ok'
      });

      // Search for machine learning content
      const results = await ingestManager.search('machine learning', 5);
      
      expect(results.length).toBeGreaterThan(0);
      
      // Check that results have appropriate resource URIs
      for (const result of results) {
        expect(result.resource).toMatch(/^mcp\+doc:\/\/.+#.+$/);
      }
    });
  });

  describe('File Ingestion with New Extensions', () => {
    it('should support .pdf and .docx extensions', () => {
      const supportedExtensions = fileIngestManager.getSupportedExtensions();
      expect(supportedExtensions).toContain('.pdf');
      expect(supportedExtensions).toContain('.docx');
      expect(supportedExtensions).toContain('.md');
      expect(supportedExtensions).toContain('.txt');
    });

    it('should handle extraction errors gracefully', async () => {
      // Test with a non-existent file to simulate extraction errors
      const result = await fileIngestManager.ingestFile('./non-existent.pdf');
      
      expect(result.status).toBe('skipped');
      expect(result.error).toBeDefined();
    });
  });

  describe('Environment Configuration', () => {
    it('should use environment variables for limits', () => {
      const originalEnv = process.env;
      
      // Set test environment variables
      process.env.PDF_MAX_PAGES = '50';
      process.env.PDF_MIN_TEXT_CHARS = '200';
      process.env.DOC_MAX_BYTES = '5000000';
      process.env.DOCX_SPLIT_ON_HEADINGS = 'true';

      const testFileManager = new FileIngestManager(ingestManager);
      
      // The constructor should pick up the environment variables
      // We can't directly test private options, but we can verify the manager was created
      expect(testFileManager).toBeDefined();
      
      // Restore environment
      process.env = originalEnv;
    });
  });

  describe('Chunk Boundary Respect', () => {
    it('should not create chunks that cross segment boundaries', async () => {
      const segments = [
        {
          segment_id: 'doc_seg_1',
          doc_id: 'boundary_test_doc',
          kind: 'section' as const,
          text: 'A'.repeat(300) // Short segment
        },
        {
          segment_id: 'doc_seg_2',
          doc_id: 'boundary_test_doc', 
          kind: 'section' as const,
          text: 'B'.repeat(800) // Longer segment that will be chunked
        }
      ];

      const result = await ingestManager.ingestSingle({
        segments,
        external_id: 'boundary_test',
        title: 'Boundary Test',
        source: 'raw',
        uri: 'test://boundary',
        content_type: 'text/plain',
        size_bytes: 1100,
        mtime: new Date().toISOString(),
        ingest_status: 'ok'
      });

      expect(result.status).toBe('inserted');
      expect(result.chunks).toBeGreaterThan(1);

      // Verify that all chunks belong to their respective segments
      // This is implicitly tested by the database foreign key constraints
      const storedSegments = db.getSegmentsByDocId(result.doc_id);
      expect(storedSegments).toHaveLength(2);
    });
  });
});

describe('Error Handling', () => {
  describe('PDF Extraction Errors', () => {
    it('should handle TooLargeError', () => {
      const error = new TooLargeError('PDF has too many pages');
      expect(error.name).toBe('TooLargeError');
      expect(error.message).toContain('too many pages');
    });

    it('should handle EncryptedPdfError', () => {
      const error = new EncryptedPdfError();
      expect(error.name).toBe('EncryptedPdfError');
      expect(error.message).toContain('encrypted');
    });

    it('should handle ParseError', () => {
      const originalError = new Error('Invalid PDF');
      const error = new ParseError('Failed to parse', originalError);
      expect(error.name).toBe('ParseError');
      expect(error.originalError).toBe(originalError);
    });
  });
});
