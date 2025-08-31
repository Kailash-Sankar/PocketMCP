import { create } from 'zustand';

export interface SearchResult {
  chunk_id: string;
  doc_id: string;
  idx: number;
  score: number;
  preview: string;
  text: string;
  title?: string;
  start_off: number;
  end_off: number;
}

export interface Document {
  doc_id: string;
  external_id: string;
  source: string;
  uri: string;
  title: string;
  content_sha256: string;
  created_at: string;
  updated_at: string;
}

export interface DbDiagnostics {
  sqlite_path: string;
  exists: boolean;
  tables: string[];
  counts: Record<string, number>;
  vec_dim?: number;
  vec_table_ok: boolean;
  wal: boolean;
  errors: string[];
}

export interface VecChunk {
  chunk_id: string;
  doc_id: string;
  idx: number;
  start_off: number;
  end_off: number;
  text: string;
}

interface AppState {
  // Search state
  query: string;
  topK: number;
  searchMode: 'like' | 'vector';
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  lastTookMs: number | null;

  // DB diagnostics
  dbStatus: DbDiagnostics | null;
  dbLoading: boolean;

  // Documents
  documents: Document[];
  documentsLoading: boolean;
  documentsPage: number;
  documentsHasMore: boolean;

  // Selected chunk
  selectedChunk: VecChunk | null;
  chunkLoading: boolean;

  // Actions
  setQuery: (query: string) => void;
  setTopK: (topK: number) => void;
  setSearchMode: (mode: 'like' | 'vector') => void;
  setResults: (results: SearchResult[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setLastTookMs: (ms: number | null) => void;
  
  setDbStatus: (status: DbDiagnostics | null) => void;
  setDbLoading: (loading: boolean) => void;
  
  setDocuments: (documents: Document[]) => void;
  setDocumentsLoading: (loading: boolean) => void;
  setDocumentsPage: (page: number) => void;
  setDocumentsHasMore: (hasMore: boolean) => void;
  
  setSelectedChunk: (chunk: VecChunk | null) => void;
  setChunkLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Initial state
  query: '',
  topK: 8,
  searchMode: 'like',
  results: [],
  loading: false,
  error: null,
  lastTookMs: null,

  dbStatus: null,
  dbLoading: false,

  documents: [],
  documentsLoading: false,
  documentsPage: 1,
  documentsHasMore: false,

  selectedChunk: null,
  chunkLoading: false,

  // Actions
  setQuery: (query) => set({ query }),
  setTopK: (topK) => set({ topK }),
  setSearchMode: (searchMode) => set({ searchMode }),
  setResults: (results) => set({ results }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setLastTookMs: (lastTookMs) => set({ lastTookMs }),
  
  setDbStatus: (dbStatus) => set({ dbStatus }),
  setDbLoading: (dbLoading) => set({ dbLoading }),
  
  setDocuments: (documents) => set({ documents }),
  setDocumentsLoading: (documentsLoading) => set({ documentsLoading }),
  setDocumentsPage: (documentsPage) => set({ documentsPage }),
  setDocumentsHasMore: (documentsHasMore) => set({ documentsHasMore }),
  
  setSelectedChunk: (selectedChunk) => set({ selectedChunk }),
  setChunkLoading: (chunkLoading) => set({ chunkLoading }),
}));
