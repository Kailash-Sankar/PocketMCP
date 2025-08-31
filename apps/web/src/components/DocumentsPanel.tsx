import React, { useEffect } from 'react';
import { FileText, RefreshCw, ChevronRight, Calendar, Hash } from 'lucide-react';
import { useAppStore } from '../store';
import { apiClient } from '../api';

export function DocumentsPanel() {
  const {
    documents,
    documentsLoading,
    documentsPage,
    documentsHasMore,
    setDocuments,
    setDocumentsLoading,
    setDocumentsPage,
    setDocumentsHasMore,
    setError,
  } = useAppStore();

  const loadDocuments = async (page: number = 1, append: boolean = false) => {
    setDocumentsLoading(true);
    setError(null);
    
    try {
      const result = await apiClient.getDocuments(page, 50);
      
      if (append) {
        setDocuments([...documents, ...result.documents]);
      } else {
        setDocuments(result.documents);
      }
      
      setDocumentsPage(page);
      setDocumentsHasMore(result.has_more);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load documents');
    } finally {
      setDocumentsLoading(false);
    }
  };

  useEffect(() => {
    loadDocuments(1);
  }, []);

  const handleRefresh = () => {
    loadDocuments(1);
  };

  const handleLoadMore = () => {
    if (!documentsLoading && documentsHasMore) {
      loadDocuments(documentsPage + 1, true);
    }
  };

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateString;
    }
  };

  const getSourceBadgeColor = (source: string) => {
    switch (source) {
      case 'file':
        return 'badge-blue';
      case 'url':
        return 'badge-green';
      case 'raw':
        return 'badge-yellow';
      default:
        return 'badge-gray';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Documents</h2>
        <button
          onClick={handleRefresh}
          disabled={documentsLoading}
          className="btn-secondary btn-sm flex items-center space-x-2"
        >
          <RefreshCw className={`h-4 w-4 ${documentsLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {documentsLoading && documents.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
          <span className="ml-2 text-gray-600">Loading documents...</span>
        </div>
      ) : (
        <>
          {documents.length > 0 ? (
            <div className="space-y-4">
              {documents.map((doc) => (
                <div key={doc.doc_id} className="card hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3 mb-2">
                        <FileText className="h-5 w-5 text-gray-600" />
                        <h3 className="text-lg font-medium text-gray-900 truncate">
                          {doc.title}
                        </h3>
                        <span className={`badge ${getSourceBadgeColor(doc.source)}`}>
                          {doc.source}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-600">
                        <div className="flex items-center space-x-2">
                          <Hash className="h-4 w-4" />
                          <span className="font-mono text-xs">
                            {doc.doc_id.substring(0, 12)}...
                          </span>
                        </div>
                        
                        <div className="flex items-center space-x-2">
                          <Calendar className="h-4 w-4" />
                          <span>{formatDate(doc.updated_at)}</span>
                        </div>
                      </div>

                      {doc.external_id && doc.external_id !== doc.doc_id && (
                        <div className="mt-2">
                          <span className="text-xs text-gray-500">External ID: </span>
                          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                            {doc.external_id}
                          </code>
                        </div>
                      )}

                      {doc.uri && (
                        <div className="mt-2">
                          <span className="text-xs text-gray-500">URI: </span>
                          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded break-all">
                            {doc.uri}
                          </code>
                        </div>
                      )}
                    </div>
                    
                    <ChevronRight className="h-5 w-5 text-gray-400 ml-4" />
                  </div>
                </div>
              ))}

              {documentsHasMore && (
                <div className="text-center pt-4">
                  <button
                    onClick={handleLoadMore}
                    disabled={documentsLoading}
                    className="btn-secondary flex items-center space-x-2 mx-auto"
                  >
                    {documentsLoading ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <span>
                      {documentsLoading ? 'Loading...' : 'Load More'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="card text-center py-12">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No Documents Found</h3>
              <p className="text-gray-500">
                No documents have been indexed yet. Try running the MCP server with file watching enabled.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
