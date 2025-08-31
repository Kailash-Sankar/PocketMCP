import { readFile } from 'fs/promises';
import { basename, extname } from 'path';

// DOCX extraction  
import mammoth from 'mammoth';

export interface ExtractedSegment {
  segment_id: string;
  kind: 'page' | 'section';
  page?: number;
  meta?: Record<string, any>;
  text: string;
}

export interface ExtractionResult {
  segments: ExtractedSegment[];
  totalText: string;
  metadata: {
    pageCount?: number;
    wordCount?: number;
    characterCount: number;
  };
}

export interface ExtractionOptions {
  pdfMaxPages?: number;
  pdfMinTextChars?: number;
  docMaxBytes?: number;
  docxSplitOnHeadings?: boolean;
}

// Custom error classes
export class ParseError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'ParseError';
  }
}

export class EncryptedPdfError extends Error {
  constructor(message: string = 'PDF is encrypted or password protected') {
    super(message);
    this.name = 'EncryptedPdfError';
  }
}

export class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

export class PdfExtractor {
  private options: Required<Pick<ExtractionOptions, 'pdfMaxPages' | 'pdfMinTextChars'>>;

  constructor(options: ExtractionOptions = {}) {
    this.options = {
      pdfMaxPages: options.pdfMaxPages || parseInt(process.env.PDF_MAX_PAGES || '300'),
      pdfMinTextChars: options.pdfMinTextChars || parseInt(process.env.PDF_MIN_TEXT_CHARS || '500')
    };
  }

  async extract(filePath: string, docId: string): Promise<ExtractionResult> {
    try {
      const buffer = await readFile(filePath);
      
      // Use unpdf for reliable PDF parsing
      const pdfData = await this.parsePdfSafely(buffer);
      const pageCount = pdfData.numpages;

      // Check page count limit
      if (pageCount > this.options.pdfMaxPages) {
        throw new TooLargeError(`PDF has ${pageCount} pages, exceeds limit of ${this.options.pdfMaxPages}`);
      }

      // Check if PDF is encrypted or empty
      if (!pdfData.text || pdfData.text.trim().length === 0) {
        if (pageCount > 0) {
          throw new EncryptedPdfError();
        }
      }

      // Check minimum text requirement
      if (pdfData.text.length < this.options.pdfMinTextChars) {
        throw new ParseError(`PDF contains only ${pdfData.text.length} characters, below minimum of ${this.options.pdfMinTextChars} (likely needs OCR)`);
      }

      // Create page segments - pass the original page array if available
      const segments = this.createPageSegments(pdfData.text, pageCount, docId, pdfData.pageTexts);
      
      return {
        segments,
        totalText: pdfData.text,
        metadata: {
          pageCount,
          characterCount: pdfData.text.length,
          wordCount: pdfData.text.split(/\s+/).filter((word: string) => word.length > 0).length
        }
      };

    } catch (error) {
      if (error instanceof TooLargeError || error instanceof EncryptedPdfError || error instanceof ParseError) {
        throw error;
      }

      // Handle common PDF parsing errors
      if (error instanceof Error) {
        if (error.message.includes('Invalid PDF') || error.message.includes('PDF header not found')) {
          throw new ParseError('Invalid PDF file format', error);
        }
        if (error.message.includes('encrypted') || error.message.includes('password')) {
          throw new EncryptedPdfError();
        }
      }

      throw new ParseError(`Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown error'}`, error instanceof Error ? error : undefined);
    }
  }

  private async parsePdfSafely(buffer: Buffer): Promise<any> {
    try {
      // Import and use unpdf - a more reliable PDF parser
      const { extractText } = await import('unpdf');
      
      // Convert Buffer to Uint8Array as required by unpdf
      const uint8Array = new Uint8Array(buffer);
      const result = await extractText(uint8Array);
      
      // Convert unpdf result to pdf-parse compatible format
      // unpdf returns text as an array (one per page), join them
      const fullText = Array.isArray(result.text) ? result.text.join('\n') : result.text;
      
      return {
        text: fullText,
        numpages: result.totalPages,
        info: {},
        metadata: {},
        pageTexts: Array.isArray(result.text) ? result.text : [result.text] // Keep original page texts for better segmentation
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Invalid PDF') || error.message.includes('PDF header not found') || error.message.includes('not a valid PDF')) {
          throw new ParseError('Invalid PDF file format', error);
        }
        if (error.message.includes('encrypted') || error.message.includes('password')) {
          throw new EncryptedPdfError();
        }
        if (error.message.includes('permission') || error.message.includes('protected')) {
          throw new EncryptedPdfError('PDF is password protected or has restricted permissions');
        }
      }
      throw new ParseError(`Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown error'}`, error instanceof Error ? error : undefined);
    }
  }

  private createPageSegments(text: string, pageCount: number, docId: string, pageTexts?: string[]): ExtractedSegment[] {
    const segments: ExtractedSegment[] = [];
    
    if (pageTexts && pageTexts.length > 0) {
      // Use the original per-page text from unpdf for better accuracy
      pageTexts.forEach((pageText, index) => {
        const pageNum = index + 1;
        if (pageText && pageText.trim().length > 0) {
          segments.push({
            segment_id: `${docId}_page_${pageNum}`,
            kind: 'page',
            page: pageNum,
            text: pageText.trim()
          });
        }
      });
    } else if (pageCount <= 1) {
      // Single page
      segments.push({
        segment_id: `${docId}_page_1`,
        kind: 'page',
        page: 1,
        text: text.trim()
      });
    } else {
      // Multiple pages - split text evenly (fallback)
      const lines = text.split('\n');
      const linesPerPage = Math.ceil(lines.length / pageCount);
      
      for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const startLine = (pageNum - 1) * linesPerPage;
        const endLine = Math.min(pageNum * linesPerPage, lines.length);
        const pageText = lines.slice(startLine, endLine).join('\n').trim();
        
        if (pageText.length > 0) {
          segments.push({
            segment_id: `${docId}_page_${pageNum}`,
            kind: 'page',
            page: pageNum,
            text: pageText
          });
        }
      }
    }
    
    return segments;
  }
}

export class DocxExtractor {
  private options: Required<Pick<ExtractionOptions, 'docMaxBytes' | 'docxSplitOnHeadings'>>;

  constructor(options: ExtractionOptions = {}) {
    this.options = {
      docMaxBytes: options.docMaxBytes || parseInt(process.env.DOC_MAX_BYTES || '10000000'),
      docxSplitOnHeadings: options.docxSplitOnHeadings || (process.env.DOCX_SPLIT_ON_HEADINGS === 'true')
    };
  }

  async extract(filePath: string, docId: string): Promise<ExtractionResult> {
    try {
      const buffer = await readFile(filePath);
      
      // Check file size limit
      if (buffer.length > this.options.docMaxBytes) {
        throw new TooLargeError(`DOCX file is ${buffer.length} bytes, exceeds limit of ${this.options.docMaxBytes}`);
      }

      // Extract text using mammoth
      const result = await mammoth.extractRawText({ buffer });
      
      if (!result.value || result.value.trim().length === 0) {
        throw new ParseError('DOCX file contains no extractable text');
      }

      const text = result.value.trim();
      
      // Log any conversion messages/warnings
      if (result.messages && result.messages.length > 0) {
        console.log(`DOCX conversion messages for ${basename(filePath)}:`, result.messages.map(m => m.message));
      }

      // Create segments
      const segments = this.options.docxSplitOnHeadings 
        ? await this.extractHeadingSegments(buffer, docId, text)
        : [this.createSingleSegment(docId, text)];

      return {
        segments,
        totalText: text,
        metadata: {
          characterCount: text.length,
          wordCount: text.split(/\s+/).filter(word => word.length > 0).length
        }
      };

    } catch (error) {
      if (error instanceof TooLargeError || error instanceof ParseError) {
        throw error;
      }

      // Handle common DOCX parsing errors
      if (error instanceof Error) {
        if (error.message.includes('not a valid zip file') || error.message.includes('Invalid DOCX')) {
          throw new ParseError('Invalid DOCX file format', error);
        }
        if (error.message.includes('corrupted') || error.message.includes('damaged')) {
          throw new ParseError('DOCX file appears to be corrupted', error);
        }
      }

      throw new ParseError(`Failed to parse DOCX: ${error instanceof Error ? error.message : 'Unknown error'}`, error instanceof Error ? error : undefined);
    }
  }

  private createSingleSegment(docId: string, text: string): ExtractedSegment {
    return {
      segment_id: `${docId}_doc`,
      kind: 'section',
      text
    };
  }

  private async extractHeadingSegments(buffer: Buffer, docId: string, fallbackText: string): Promise<ExtractedSegment[]> {
    try {
      // Extract with style information to detect headings
      const result = await mammoth.convertToHtml({ buffer }, {
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Title'] => h1:fresh"
        ]
      });

      if (!result.value) {
        return [this.createSingleSegment(docId, fallbackText)];
      }

      // Parse HTML to extract sections
      const sections = this.parseHtmlSections(result.value, docId);
      
      if (sections.length === 0) {
        return [this.createSingleSegment(docId, fallbackText)];
      }

      return sections;

    } catch (error) {
      console.warn('Failed to extract heading segments, using single segment:', error);
      return [this.createSingleSegment(docId, fallbackText)];
    }
  }

  private parseHtmlSections(html: string, docId: string): ExtractedSegment[] {
    const segments: ExtractedSegment[] = [];
    
    // Simple HTML parsing to extract sections
    // This is a basic implementation - in production you might want to use a proper HTML parser
    const headingRegex = /<h([12])>(.*?)<\/h[12]>/gi;
    const sections = html.split(headingRegex);
    
    let currentHeading = '';
    let currentLevel = 0;
    let sectionIndex = 0;
    
    for (let i = 0; i < sections.length; i++) {
      if (i % 3 === 1) {
        // This is a heading level (1 or 2)
        currentLevel = parseInt(sections[i]);
      } else if (i % 3 === 2) {
        // This is heading text
        currentHeading = this.stripHtmlTags(sections[i]);
      } else if (i % 3 === 0 && sections[i].trim()) {
        // This is content
        const content = this.stripHtmlTags(sections[i]).trim();
        if (content.length > 0) {
          segments.push({
            segment_id: `${docId}_section_${sectionIndex++}`,
            kind: 'section',
            meta: currentHeading ? { heading: currentHeading, level: currentLevel } : undefined,
            text: content
          });
        }
      }
    }

    return segments;
  }

  private stripHtmlTags(html: string): string {
    return html
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/&nbsp;/g, ' ') // Replace non-breaking spaces
      .replace(/&amp;/g, '&') // Replace HTML entities
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }
}

// Factory function for creating extractors
export function createExtractor(filePath: string, options: ExtractionOptions = {}): PdfExtractor | DocxExtractor | null {
  const ext = extname(filePath).toLowerCase();
  
  switch (ext) {
    case '.pdf':
      return new PdfExtractor(options);
    case '.docx':
      return new DocxExtractor(options);
    default:
      return null;
  }
}

// Utility function to detect content type
export function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.md':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
