import React, { useState } from 'react';
import { Search, Clock, Eye, AlertCircle } from 'lucide-react';
import { useAppStore } from '../store';
import { apiClient } from '../api';

export function SearchPanel() {
  const {
    query,
    topK,
    searchMode,
    results,
    loading,
    error,
    lastTookMs,
    setQuery,
    setTopK,
    setSearchMode,
    setResults,
    setLoading,
    setError,
    setLastTookMs,
    setSelectedChunk,
    setChunkLoading,
  } = useAppStore();

  const [localQuery, setLocalQuery] = useState(query);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localQuery.trim()) return;

    setLoading(true);
    setError(null);
    setQuery(localQuery);

    try {
      const result = await apiClient.search(localQuery, topK, searchMode);
      setResults(result.matches);
      setLastTookMs(result.took_ms);
      
      // Show feedback if model was initialized or if fallback occurred
      if (result.model_initialized) {
        // Show a temporary success message that the model was initialized
        setTimeout(() => {
          setError('✅ Vector search model initialized successfully!');
          setTimeout(() => setError(null), 3000);
        }, 100);
      } else if (result.requested_mode === 'vector' && result.mode === 'like') {
        setError('⚠️ Vector search unavailable, used text search instead');
        setTimeout(() => setError(null), 5000);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleViewChunk = async (chunkId: string) => {
    setChunkLoading(true);
    try {
      const chunk = await apiClient.getChunk(chunkId);
      setSelectedChunk(chunk);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load chunk');
    } finally {
      setChunkLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Search</h2>

        {/* Search Form */}
        <form onSubmit={handleSearch} className="card mb-6">
          <div className="space-y-4">
            <div>
              <label htmlFor="query" className="block text-sm font-medium text-gray-700 mb-2">
                Search Query
              </label>
              <input
                id="query"
                type="text"
                value={localQuery}
                onChange={(e) => setLocalQuery(e.target.value)}
                placeholder="Enter your search query..."
                className="input"
                disabled={loading}
              />
            </div>

            <div className="flex space-x-4">
              <div className="flex-1">
                <label htmlFor="topK" className="block text-sm font-medium text-gray-700 mb-2">
                  Top K Results
                </label>
                <select
                  id="topK"
                  value={topK}
                  onChange={(e) => setTopK(parseInt(e.target.value))}
                  className="select"
                  disabled={loading}
                >
                  <option value={5}>5</option>
                  <option value={8}>8</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                </select>
              </div>

              <div className="flex-1">
                <label htmlFor="mode" className="block text-sm font-medium text-gray-700 mb-2">
                  Search Mode
                </label>
                <select
                  id="mode"
                  value={searchMode}
                  onChange={(e) => setSearchMode(e.target.value as 'like' | 'vector')}
                  className="select"
                  disabled={loading}
                >
                  <option value="like">LIKE Search</option>
                  <option value="vector">Vector Search</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !localQuery.trim()}
              className="btn-primary flex items-center space-x-2"
            >
              <Search className={`h-4 w-4 ${loading ? 'animate-pulse' : ''}`} />
              <span>
                {loading 
                  ? (searchMode === 'vector' ? 'Initializing & Searching...' : 'Searching...') 
                  : 'Search'
                }
              </span>
            </button>
          </div>
        </form>

        {/* Search Results */}
        {error && (
          <div className={`card mb-6 ${
            error.startsWith('✅') 
              ? 'border-green-200 bg-green-50' 
              : error.startsWith('⚠️')
              ? 'border-yellow-200 bg-yellow-50'
              : 'border-red-200 bg-red-50'
          }`}>
            <div className={`flex items-center space-x-2 ${
              error.startsWith('✅') 
                ? 'text-green-600' 
                : error.startsWith('⚠️')
                ? 'text-yellow-600'
                : 'text-red-600'
            }`}>
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">
                {error.startsWith('✅') ? 'Success:' : error.startsWith('⚠️') ? 'Warning:' : 'Error:'}
              </span>
              <span>{error}</span>
            </div>
          </div>
        )}

        {lastTookMs !== null && (
          <div className="flex items-center space-x-2 text-sm text-gray-600 mb-4">
            <Clock className="h-4 w-4" />
            <span>Search completed in {lastTookMs}ms</span>
            <span>•</span>
            <span>{results.length} results</span>
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-4">
            {results.map((result) => (
              <div key={result.chunk_id} className="card hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-3 mb-2">
                      <span className="badge-blue">
                        Score: {result.score.toFixed(3)}
                      </span>
                      {result.title && (
                        <span className="text-sm font-medium text-gray-900">
                          {result.title}
                        </span>
                      )}
                      <span className="text-xs text-gray-500">
                        Chunk {result.idx + 1}
                      </span>
                    </div>
                    <p className="text-gray-700 text-sm leading-relaxed">
                      {result.preview}
                    </p>
                    <div className="flex items-center space-x-4 mt-3 text-xs text-gray-500">
                      <span>Doc ID: {result.doc_id.substring(0, 8)}...</span>
                      <span>Offset: {result.start_off}-{result.end_off}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleViewChunk(result.chunk_id)}
                    className="btn-secondary btn-sm flex items-center space-x-1 ml-4"
                  >
                    <Eye className="h-3 w-3" />
                    <span>View</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {query && results.length === 0 && !loading && !error && (
          <div className="card text-center py-8">
            <p className="text-gray-500">No results found for "{query}"</p>
            <p className="text-sm text-gray-400 mt-1">
              Try a different search term or check if documents are indexed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
