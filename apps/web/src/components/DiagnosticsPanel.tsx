import { useEffect } from 'react';
import { RefreshCw, CheckCircle, XCircle, AlertCircle, Database, HardDrive } from 'lucide-react';
import { useAppStore } from '../store';
import { apiClient } from '../api';

export function DiagnosticsPanel() {
  const {
    dbStatus,
    dbLoading,
    setDbStatus,
    setDbLoading,
    setError,
  } = useAppStore();

  const loadDiagnostics = async () => {
    setDbLoading(true);
    setError(null);
    try {
      const diagnostics = await apiClient.getDiagnostics();
      setDbStatus(diagnostics);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load diagnostics');
    } finally {
      setDbLoading(false);
    }
  };

  useEffect(() => {
    loadDiagnostics();
  }, []);

  const runSmokeTest = async () => {
    try {
      setError(null);
      const result = await apiClient.search('test', 3, 'like');
      if (result.matches.length > 0) {
        alert(`Smoke test passed! Found ${result.matches.length} results in ${result.took_ms}ms`);
      } else {
        alert('Smoke test completed but no results found. Try adding some documents first.');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Smoke test failed');
    }
  };

  if (dbLoading && !dbStatus) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-600">Loading diagnostics...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Database Diagnostics</h2>
        <button
          onClick={loadDiagnostics}
          disabled={dbLoading}
          className="btn-secondary btn-sm flex items-center space-x-2"
        >
          <RefreshCw className={`h-4 w-4 ${dbLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {dbStatus && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Database File Status */}
          <div className="card">
            <div className="flex items-center space-x-3 mb-4">
              <HardDrive className="h-5 w-5 text-gray-600" />
              <h3 className="text-lg font-semibold">Database File</h3>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Path:</span>
                <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                  {dbStatus.sqlite_path}
                </code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Exists:</span>
                {dbStatus.exists ? (
                  <span className="badge-green">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Yes
                  </span>
                ) : (
                  <span className="badge-red">
                    <XCircle className="h-3 w-3 mr-1" />
                    No
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">WAL Mode:</span>
                {dbStatus.wal ? (
                  <span className="badge-green">Enabled</span>
                ) : (
                  <span className="badge-yellow">Disabled</span>
                )}
              </div>
            </div>
          </div>

          {/* Tables and Counts */}
          <div className="card">
            <div className="flex items-center space-x-3 mb-4">
              <Database className="h-5 w-5 text-gray-600" />
              <h3 className="text-lg font-semibold">Tables & Counts</h3>
            </div>
            <div className="space-y-2">
              {Object.entries(dbStatus.counts).map(([table, count]) => (
                <div key={table} className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{table}:</span>
                  <span className="badge-blue">{count.toLocaleString()}</span>
                </div>
              ))}
              {Object.keys(dbStatus.counts).length === 0 && (
                <p className="text-sm text-gray-500 italic">No tables found</p>
              )}
            </div>
          </div>

          {/* Vector Table Status */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Vector Table Status</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">vec_chunks OK:</span>
                {dbStatus.vec_table_ok ? (
                  <span className="badge-green">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Yes
                  </span>
                ) : (
                  <span className="badge-red">
                    <XCircle className="h-3 w-3 mr-1" />
                    No
                  </span>
                )}
              </div>
              {dbStatus.vec_dim && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Vector Dimension:</span>
                  <span className="badge-blue">{dbStatus.vec_dim}</span>
                </div>
              )}
            </div>
          </div>

          {/* Errors */}
          {dbStatus.errors.length > 0 && (
            <div className="card">
              <div className="flex items-center space-x-3 mb-4">
                <AlertCircle className="h-5 w-5 text-red-600" />
                <h3 className="text-lg font-semibold text-red-600">Errors</h3>
              </div>
              <div className="space-y-2">
                {dbStatus.errors.map((error, index) => (
                  <div key={index} className="text-sm text-red-600 bg-red-50 p-2 rounded">
                    {error}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Smoke Test */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Smoke Test</h3>
        <p className="text-sm text-gray-600 mb-4">
          Run a quick search test to verify the system is working properly.
        </p>
        <button
          onClick={runSmokeTest}
          className="btn-primary"
          disabled={!dbStatus?.exists || !dbStatus?.vec_table_ok}
        >
          Run Smoke Test
        </button>
        {(!dbStatus?.exists || !dbStatus?.vec_table_ok) && (
          <p className="text-sm text-gray-500 mt-2">
            Database must exist and vec_chunks table must be OK to run smoke test.
          </p>
        )}
      </div>
    </div>
  );
}
