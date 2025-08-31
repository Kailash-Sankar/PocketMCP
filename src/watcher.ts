import chokidar, { FSWatcher } from 'chokidar';
import pLimit from 'p-limit';
import { FileIngestManager, FileIngestResult } from './file-ingest.js';
import { resolve, extname } from 'path';

export interface WatcherOptions {
  watchDir: string;
  debounceMs?: number;
  maxConcurrency?: number;
  supportedExtensions?: string[];
  ignorePatterns?: string[];
  initialScan?: boolean;
}

export interface WatcherEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

export interface WatcherStats {
  filesWatched: number;
  eventsProcessed: number;
  lastActivity: Date | null;
  pendingOperations: number;
  errors: number;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private fileIngest: FileIngestManager;
  private options: Required<WatcherOptions>;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private concurrencyLimit: ReturnType<typeof pLimit>;
  private stats: WatcherStats = {
    filesWatched: 0,
    eventsProcessed: 0,
    lastActivity: null,
    pendingOperations: 0,
    errors: 0
  };

  constructor(fileIngest: FileIngestManager, options: WatcherOptions) {
    this.fileIngest = fileIngest;
    this.options = {
      watchDir: options.watchDir,
      debounceMs: options.debounceMs || 600,
      maxConcurrency: options.maxConcurrency || 3,
      supportedExtensions: options.supportedExtensions || ['.md', '.txt'],
      ignorePatterns: options.ignorePatterns || [
        '~$*', '*.tmp', '*.temp', '.DS_Store', 'Thumbs.db',
        '.git/**', 'node_modules/**', '**/.git/**', '**/node_modules/**'
      ],
      initialScan: options.initialScan !== false
    };
    
    this.concurrencyLimit = pLimit(this.options.maxConcurrency);
  }

  async start(): Promise<void> {
    if (this.watcher) {
      console.log('File watcher already running');
      return;
    }

    const watchPath = resolve(this.options.watchDir);
    console.log(`Starting file watcher on: ${watchPath}`);

    // Create chokidar watcher
    this.watcher = chokidar.watch(watchPath, {
      ignored: this.buildIgnorePatterns(),
      persistent: true,
      ignoreInitial: !this.options.initialScan,
      followSymlinks: false,
      depth: undefined, // Watch all subdirectories
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      },
      usePolling: false, // Use native events when possible
      interval: 1000,
      binaryInterval: 2000
    });

    // Set up event handlers
    this.watcher.on('add', (path: string) => this.handleFileEvent('add', path));
    this.watcher.on('change', (path: string) => this.handleFileEvent('change', path));
    this.watcher.on('unlink', (path: string) => this.handleFileEvent('unlink', path));
    
    this.watcher.on('error', (error: unknown) => {
      console.error('File watcher error:', error);
      this.stats.errors++;
    });

    this.watcher.on('ready', () => {
      console.log('File watcher is ready and watching for changes');
      const watched = this.watcher?.getWatched();
      if (watched) {
        this.stats.filesWatched = Object.values(watched)
          .reduce((total: number, files: unknown) => {
            if (Array.isArray(files)) {
              return total + files.length;
            }
            return total;
          }, 0);
      }
    });

    // Wait for initial scan if enabled
    if (this.options.initialScan) {
      await new Promise<void>((resolve) => {
        this.watcher!.on('ready', resolve);
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    console.log('Stopping file watcher...');
    
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close watcher
    await this.watcher.close();
    this.watcher = null;

    console.log('File watcher stopped');
  }

  private handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): void {
    // Filter supported file extensions
    if (!this.isSupportedFile(filePath)) {
      return;
    }

    const absolutePath = resolve(filePath);
    
    // Clear existing debounce timer for this file
    const existingTimer = this.debounceTimers.get(absolutePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(absolutePath);
      this.processFileEvent(type, absolutePath);
    }, this.options.debounceMs);

    this.debounceTimers.set(absolutePath, timer);
  }

  private async processFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): Promise<void> {
    const startTime = Date.now();
    this.stats.pendingOperations++;
    
    try {
      await this.concurrencyLimit(async () => {
        this.stats.lastActivity = new Date();
        
        switch (type) {
          case 'add':
            await this.handleFileAdd(filePath);
            break;
          case 'change':
            await this.handleFileChange(filePath);
            break;
          case 'unlink':
            await this.handleFileDelete(filePath);
            break;
        }
        
        this.stats.eventsProcessed++;
        const duration = Date.now() - startTime;
        console.log(`${type.toUpperCase()} ${filePath} (${duration}ms)`);
      });
    } catch (error) {
      this.stats.errors++;
      console.error(`Error processing ${type} event for ${filePath}:`, error);
    } finally {
      this.stats.pendingOperations--;
    }
  }

  private async handleFileAdd(filePath: string): Promise<void> {
    const result = await this.fileIngest.ingestFile(filePath);
    this.logIngestResult('Added', result);
  }

  private async handleFileChange(filePath: string): Promise<void> {
    const result = await this.fileIngest.ingestFile(filePath);
    this.logIngestResult('Changed', result);
  }

  private async handleFileDelete(filePath: string): Promise<void> {
    const result = await this.fileIngest.deleteFile(filePath);
    console.log(`Deleted file ${filePath}: ${result.deletedDocIds.length} documents, ${result.deletedChunks} chunks`);
  }

  private logIngestResult(action: string, result: FileIngestResult): void {
    if (result.error) {
      console.error(`${action} ${result.filePath}: ERROR - ${result.error}`);
    } else {
      const statusText = result.status === 'inserted' ? 'inserted' : 
                       result.status === 'updated' ? 'updated' : 'skipped';
      console.log(`${action} ${result.filePath}: ${statusText} (${result.chunks} chunks)`);
    }
  }

  private isSupportedFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return this.options.supportedExtensions.includes(ext);
  }

  private buildIgnorePatterns(): Array<string | RegExp> {
    const patterns: Array<string | RegExp> = [];
    
    for (const pattern of this.options.ignorePatterns) {
      // Convert glob patterns to chokidar format
      if (pattern.includes('*')) {
        // Convert to regex for more complex patterns
        const regexPattern = pattern
          .replace(/\*\*/g, '###DOUBLESTAR###')
          .replace(/\*/g, '[^/\\\\]*')
          .replace(/###DOUBLESTAR###/g, '.*')
          .replace(/\?/g, '.')
          .replace(/\./g, '\\.');
        
        patterns.push(new RegExp(regexPattern));
      } else {
        patterns.push(pattern);
      }
    }
    
    return patterns;
  }

  // Status and control methods
  isRunning(): boolean {
    return this.watcher !== null;
  }

  getStats(): WatcherStats {
    return { ...this.stats };
  }

  getWatchedPaths(): string[] {
    if (!this.watcher) {
      return [];
    }

    const watched = this.watcher.getWatched();
    const paths: string[] = [];
    
    for (const [dir, files] of Object.entries(watched)) {
      if (Array.isArray(files)) {
        for (const file of files) {
          if (typeof file === 'string') {
            paths.push(resolve(dir, file));
          }
        }
      }
    }
    
    return paths.sort();
  }

  async forceRescan(): Promise<void> {
    if (!this.watcher) {
      console.log('Watcher not running, cannot rescan');
      return;
    }

    console.log('Starting forced rescan...');
    const watchDir = resolve(this.options.watchDir);
    
    try {
      const results = await this.fileIngest.ingestDirectory(watchDir);
      const inserted = results.filter(r => r.status === 'inserted').length;
      const updated = results.filter(r => r.status === 'updated').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      const errors = results.filter(r => r.error).length;
      
      console.log(`Rescan complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${errors} errors`);
    } catch (error) {
      console.error('Error during forced rescan:', error);
      throw error;
    }
  }

  // Configuration methods
  updateDebounceMs(ms: number): void {
    this.options.debounceMs = ms;
    console.log(`Updated debounce to ${ms}ms`);
  }

  updateMaxConcurrency(limit: number): void {
    this.options.maxConcurrency = limit;
    this.concurrencyLimit = pLimit(limit);
    console.log(`Updated concurrency limit to ${limit}`);
  }
}
