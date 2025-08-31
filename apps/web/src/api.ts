import { DbDiagnostics, Document, SearchResult, VecChunk } from './store';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5174';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return this.request('/health');
  }

  async getDiagnostics(): Promise<DbDiagnostics> {
    return this.request('/api/db/diag');
  }

  async search(query: string, topK: number = 8, mode: 'like' | 'vector' = 'like'): Promise<{
    matches: SearchResult[];
    took_ms: number;
    query: string;
    mode: string;
    total: number;
  }> {
    return this.request('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query, top_k: topK, mode }),
    });
  }

  async getChunk(chunkId: string): Promise<VecChunk> {
    return this.request(`/api/chunk/${chunkId}`);
  }

  async getDocuments(page: number = 1, limit: number = 50): Promise<{
    documents: Document[];
    page: number;
    limit: number;
    has_more: boolean;
    next_cursor?: string;
  }> {
    return this.request(`/api/docs?page=${page}&limit=${limit}`);
  }
}

export const apiClient = new ApiClient();
