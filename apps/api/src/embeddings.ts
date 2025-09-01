import { pipeline } from '@huggingface/transformers';

export class ApiEmbeddingManager {
  private pipeline: any = null;
  private isLoading = false;
  private modelId = 'Xenova/all-MiniLM-L6-v2';

  async initialize(): Promise<void> {
    if (this.pipeline || this.isLoading) {
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
      const result = await this.pipeline(text, { pooling: 'mean', normalize: true });

      // The result should now be a pooled embedding
      let embedding: Float32Array;
      
      if (result instanceof Float32Array) {
        embedding = result;
      } else if (Array.isArray(result)) {
        embedding = new Float32Array(result);
      } else if (result && typeof result === 'object' && 'data' in result) {
        const data = (result as any).data;
        if (Array.isArray(data)) {
          embedding = new Float32Array(data);
        } else if (data instanceof Float32Array) {
          embedding = data;
        } else {
          embedding = new Float32Array(Array.from(data));
        }
      } else {
        throw new Error('Unexpected embedding result format');
      }

      // If we still get a multi-dimensional result, apply mean pooling manually
      if (embedding.length !== 384) {
        console.warn(`Got embedding of length ${embedding.length}, expected 384. Applying manual pooling.`);
        embedding = this.applyMeanPooling(embedding);
      }

      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  private applyMeanPooling(tokenEmbeddings: Float32Array): Float32Array {
    // Assume the embeddings are in format [num_tokens, embedding_dim]
    // where embedding_dim = 384 for all-MiniLM-L6-v2
    const embeddingDim = 384;
    const numTokens = tokenEmbeddings.length / embeddingDim;
    
    if (numTokens !== Math.floor(numTokens)) {
      throw new Error(`Invalid embedding dimensions: ${tokenEmbeddings.length} is not divisible by ${embeddingDim}`);
    }

    const pooled = new Float32Array(embeddingDim);
    
    // Sum across tokens
    for (let token = 0; token < numTokens; token++) {
      for (let dim = 0; dim < embeddingDim; dim++) {
        pooled[dim] += tokenEmbeddings[token * embeddingDim + dim];
      }
    }
    
    // Average (mean pooling)
    for (let dim = 0; dim < embeddingDim; dim++) {
      pooled[dim] /= numTokens;
    }
    
    return pooled;
  }

  isReady(): boolean {
    return this.pipeline !== null;
  }
}
