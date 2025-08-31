import { pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';

export class EmbeddingManager {
  private pipeline: FeatureExtractionPipeline | null = null;
  private modelId: string;
  private isLoading = false;

  constructor(modelId: string = 'Xenova/all-MiniLM-L6-v2') {
    this.modelId = modelId;
  }

  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.isLoading) {
      // Wait for existing initialization to complete
      while (this.isLoading) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isLoading = true;
    try {
      console.log(`Loading embedding model: ${this.modelId}...`);
      this.pipeline = await pipeline('feature-extraction', this.modelId);
      console.log('Embedding model loaded successfully');
    } catch (error) {
      console.error('Failed to load embedding model:', error);
      throw error;
    } finally {
      this.isLoading = false;
    }
  }

  async embedSingle(text: string): Promise<Float32Array> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    try {
      const result = await this.pipeline(text);

      // Convert to Float32Array
      if (result instanceof Float32Array) {
        return result;
      } else if (Array.isArray(result)) {
        return new Float32Array(result);
      } else if (result && typeof result === 'object' && 'data' in result) {
        const data = (result as any).data;
        if (Array.isArray(data)) {
          return new Float32Array(data);
        } else if (data instanceof Float32Array) {
          return data;
        } else {
          return new Float32Array(Array.from(data));
        }
      } else {
        throw new Error('Unexpected embedding result format');
      }
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    if (texts.length === 0) {
      return [];
    }

    try {
      // Process in batches to manage memory
      const batchSize = 32;
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        
        console.log(`Processing embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} texts)`);
        
        const batchResults = await Promise.all(
          batch.map(text => this.embedSingle(text))
        );
        
        results.push(...batchResults);
      }

      return results;
    } catch (error) {
      console.error('Error generating batch embeddings:', error);
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.pipeline !== null;
  }

  getModelId(): string {
    return this.modelId;
  }

  getDimensions(): number {
    // all-MiniLM-L6-v2 produces 384-dimensional embeddings
    return 384;
  }
}
