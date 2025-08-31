import { readFile, stat } from 'fs/promises';
import { resolve, relative, basename, extname } from 'path';
import { createHash } from 'crypto';
import { IngestManager, IngestResult } from './ingest.js';

export interface FileIngestOptions {
  watchDir?: string;
  supportedExtensions?: string[];
  ignorePatterns?: string[];
  maxFileSize?: number; // in bytes
}

export interface FileIngestResult extends IngestResult {
  filePath: string;
  error?: string;
}

export class FileIngestManager {
  private ingestManager: IngestManager;
  private options: Required<FileIngestOptions>;

  constructor(ingestManager: IngestManager, options: FileIngestOptions = {}) {
    this.ingestManager = ingestManager;
    this.options = {
      watchDir: options.watchDir || './kb',
      supportedExtensions: options.supportedExtensions || ['.md', '.txt'],
      ignorePatterns: options.ignorePatterns || [
        '~$*',      // Temp files
        '*.tmp',    // Temp files
        '*.temp',   // Temp files
        '.DS_Store', // macOS
        'Thumbs.db', // Windows
        '.git/**',   // Git files
        'node_modules/**', // Node modules
      ],
      maxFileSize: options.maxFileSize || 50 * 1024 * 1024 // 50MB
    };
  }

  async ingestFile(filePath: string): Promise<FileIngestResult> {
    const absolutePath = resolve(filePath);
    
    try {
      // Security and validation checks
      if (!await this.shouldProcessFile(absolutePath)) {
        return {
          filePath: absolutePath,
          doc_id: '',
          chunks: 0,
          status: 'skipped',
          error: 'File filtered out by rules'
        };
      }

      // Read file content
      const content = await this.readFileContent(absolutePath);
      if (!content) {
        return {
          filePath: absolutePath,
          doc_id: '',
          chunks: 0,
          status: 'skipped',
          error: 'Empty file content'
        };
      }

      // Extract file metadata
      const fileStats = await stat(absolutePath);
      const fileName = basename(absolutePath);
      const title = this.extractTitle(fileName, content);
      const uri = `file://${absolutePath}`;
      const externalId = this.normalizeFilePath(absolutePath);

      // Ingest the document
      const result = await this.ingestManager.ingestSingle({
        text: content,
        external_id: externalId,
        title,
        source: 'file',
        uri,
        metadata: {
          fileName,
          filePath: absolutePath,
          fileSize: fileStats.size,
          lastModified: fileStats.mtime.toISOString(),
          extension: extname(absolutePath)
        }
      });

      return {
        ...result,
        filePath: absolutePath
      };

    } catch (error) {
      console.error(`Error ingesting file ${absolutePath}:`, error);
      return {
        filePath: absolutePath,
        doc_id: '',
        chunks: 0,
        status: 'skipped',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async ingestDirectory(dirPath: string): Promise<FileIngestResult[]> {
    const absolutePath = resolve(dirPath);
    const files = await this.findSupportedFiles(absolutePath);
    
    console.log(`Found ${files.length} files to ingest in ${absolutePath}`);
    
    const results: FileIngestResult[] = [];
    
    // Process files in batches to manage memory and avoid overwhelming the system
    const batchSize = 5;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchPromises = batch.map(file => this.ingestFile(file));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Log progress
      console.log(`Processed ${Math.min(i + batchSize, files.length)}/${files.length} files`);
    }
    
    return results;
  }

  async deleteFile(filePath: string): Promise<{ deletedDocIds: string[]; deletedChunks: number }> {
    const absolutePath = resolve(filePath);
    const externalId = this.normalizeFilePath(absolutePath);
    
    return await this.ingestManager.deleteDocuments(undefined, [externalId]);
  }

  private async shouldProcessFile(filePath: string): Promise<boolean> {
    try {
      // Check if file exists and is readable
      const stats = await stat(filePath);
      
      if (!stats.isFile()) {
        return false;
      }

      // Check file size
      if (stats.size > this.options.maxFileSize) {
        console.log(`Skipping large file: ${filePath} (${stats.size} bytes)`);
        return false;
      }

      if (stats.size === 0) {
        return false;
      }

      // Check extension
      const ext = extname(filePath).toLowerCase();
      if (!this.options.supportedExtensions.includes(ext)) {
        return false;
      }

      // Check ignore patterns
      const fileName = basename(filePath);
      const relativePath = this.options.watchDir 
        ? relative(this.options.watchDir, filePath)
        : filePath;

      for (const pattern of this.options.ignorePatterns) {
        if (this.matchesPattern(fileName, pattern) || 
            this.matchesPattern(relativePath, pattern)) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private matchesPattern(text: string, pattern: string): boolean {
    // Simple glob-like pattern matching
    const regexPattern = pattern
      .replace(/\*\*/g, '.*')     // ** matches any path
      .replace(/\*/g, '[^/]*')    // * matches any filename chars
      .replace(/\?/g, '.')        // ? matches single char
      .replace(/\./g, '\\.');     // Escape dots
    
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(text);
  }

  private async readFileContent(filePath: string): Promise<string> {
    try {
      const buffer = await readFile(filePath);
      
      // Simple text detection - check if content is mostly text
      const text = buffer.toString('utf8');
      
      // Basic binary detection
      const nullBytes = (text.match(/\x00/g) || []).length;
      if (nullBytes > text.length * 0.01) {
        throw new Error('Binary file detected');
      }

      return text;
    } catch (error) {
      if (error instanceof Error && error.message === 'Binary file detected') {
        throw error;
      }
      
      // Try reading as different encodings
      try {
        const buffer = await readFile(filePath);
        return buffer.toString('latin1');
      } catch {
        throw new Error('Could not read file content');
      }
    }
  }

  private extractTitle(fileName: string, content: string): string {
    // Try to extract title from content first
    const lines = content.split('\n').slice(0, 10); // Check first 10 lines
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Markdown heading
      if (trimmed.match(/^#\s+(.+)$/)) {
        return trimmed.replace(/^#\s+/, '').trim();
      }
      
      // Title-like pattern at start of document
      if (trimmed.length > 3 && trimmed.length < 100 && 
          !trimmed.includes('.') && !trimmed.includes(',') &&
          trimmed.match(/^[A-Z]/)) {
        return trimmed;
      }
    }
    
    // Fall back to filename without extension
    const nameWithoutExt = basename(fileName, extname(fileName));
    return nameWithoutExt
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  private normalizeFilePath(filePath: string): string {
    // Create a consistent external ID for file paths
    // This helps handle path changes and ensures uniqueness
    return resolve(filePath).replace(/\\/g, '/');
  }

  private async findSupportedFiles(dirPath: string): Promise<string[]> {
    const { default: fastGlob } = await import('fast-glob');
    
    // Build glob patterns for supported extensions
    const patterns = this.options.supportedExtensions.map(ext => 
      `**/*${ext}`
    );
    
    // Build ignore patterns
    const ignore = this.options.ignorePatterns.map(pattern => {
      // Convert our simple patterns to fast-glob format
      return pattern.replace(/\*\*/g, '**/*');
    });

    try {
      const files = await fastGlob(patterns, {
        cwd: dirPath,
        absolute: true,
        ignore,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true
      });

      // Additional filtering
      const validFiles: string[] = [];
      for (const file of files) {
        if (await this.shouldProcessFile(file)) {
          validFiles.push(file);
        }
      }

      return validFiles.sort(); // Deterministic order
    } catch (error) {
      console.error(`Error finding files in ${dirPath}:`, error);
      return [];
    }
  }

  // Utility methods
  getSupportedExtensions(): string[] {
    return [...this.options.supportedExtensions];
  }

  getIgnorePatterns(): string[] {
    return [...this.options.ignorePatterns];
  }

  getWatchDir(): string {
    return this.options.watchDir;
  }

  updateOptions(newOptions: Partial<FileIngestOptions>): void {
    this.options = { ...this.options, ...newOptions };
  }
}
