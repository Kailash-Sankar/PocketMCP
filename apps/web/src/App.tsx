import { useState } from 'react';
import { Database, Search, FileText, Activity } from 'lucide-react';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { SearchPanel } from './components/SearchPanel';
import { DocumentsPanel } from './components/DocumentsPanel';
import { ChunkModal } from './components/ChunkModal';

type Tab = 'diagnostics' | 'search' | 'documents';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('diagnostics');

  const tabs = [
    { id: 'diagnostics' as Tab, label: 'DB Status', icon: Database },
    { id: 'search' as Tab, label: 'Search', icon: Search },
    { id: 'documents' as Tab, label: 'Documents', icon: FileText },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-3">
              <Activity className="h-8 w-8 text-blue-600" />
              <h1 className="text-xl font-semibold text-gray-900">
                PocketMCP Web Tester
              </h1>
            </div>
            <div className="flex space-x-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center space-x-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      activeTab === tab.id
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'diagnostics' && <DiagnosticsPanel />}
        {activeTab === 'search' && <SearchPanel />}
        {activeTab === 'documents' && <DocumentsPanel />}
      </main>

      <ChunkModal />
    </div>
  );
}

export default App;
