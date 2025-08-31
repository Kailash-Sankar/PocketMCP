import React from 'react';
import { X, Copy, Hash, FileText } from 'lucide-react';
import { useAppStore } from '../store';

export function ChunkModal() {
  const { selectedChunk, chunkLoading, setSelectedChunk } = useAppStore();

  if (!selectedChunk && !chunkLoading) return null;

  const handleClose = () => {
    setSelectedChunk(null);
  };

  const handleCopyText = () => {
    if (selectedChunk?.text) {
      navigator.clipboard.writeText(selectedChunk.text);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <FileText className="h-6 w-6 text-gray-600" />
            <h2 className="text-xl font-semibold text-gray-900">
              {chunkLoading ? 'Loading Chunk...' : 'Chunk Details'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
          {chunkLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-2 text-gray-600">Loading chunk details...</span>
            </div>
          ) : selectedChunk ? (
            <div className="space-y-6">
              {/* Metadata */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center space-x-2">
                  <Hash className="h-4 w-4 text-gray-500" />
                  <span className="text-sm text-gray-600">Chunk ID:</span>
                  <code className="text-xs bg-white px-2 py-1 rounded border">
                    {selectedChunk.chunk_id}
                  </code>
                </div>
                
                <div className="flex items-center space-x-2">
                  <Hash className="h-4 w-4 text-gray-500" />
                  <span className="text-sm text-gray-600">Doc ID:</span>
                  <code className="text-xs bg-white px-2 py-1 rounded border">
                    {selectedChunk.doc_id}
                  </code>
                </div>
                
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-600">Index:</span>
                  <span className="badge-blue">{selectedChunk.idx}</span>
                </div>
                
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-600">Offset:</span>
                  <span className="text-sm text-gray-900">
                    {selectedChunk.start_off} - {selectedChunk.end_off}
                  </span>
                </div>
              </div>

              {/* Text Content */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-medium text-gray-900">Text Content</h3>
                  <button
                    onClick={handleCopyText}
                    className="btn-secondary btn-sm flex items-center space-x-1"
                  >
                    <Copy className="h-3 w-3" />
                    <span>Copy</span>
                  </button>
                </div>
                
                <div className="bg-gray-50 rounded-lg p-4 border">
                  <pre className="whitespace-pre-wrap text-sm text-gray-900 leading-relaxed">
                    {selectedChunk.text}
                  </pre>
                </div>
                
                <div className="mt-2 text-xs text-gray-500">
                  {selectedChunk.text.length} characters
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-6 border-t border-gray-200">
          <button onClick={handleClose} className="btn-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
