#!/usr/bin/env node

import { spawn } from 'child_process';
import { resolve } from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const MCP_PORT = parseInt(process.env.HTTP_PORT || '8001');
const API_PORT = parseInt(process.env.API_PORT || '5174');
const WEB_PORT = parseInt(process.env.WEB_PORT || '5173');
const HOST = process.env.HTTP_HOST || '0.0.0.0';

console.log('🚀 Starting PocketMCP All-in-One Server...');
console.log(`📊 MCP Server: http://${HOST}:${MCP_PORT}`);
console.log(`🔧 API Server: http://${HOST}:${API_PORT}`);
console.log(`🌐 Web UI: http://${HOST}:${WEB_PORT}`);

// Track child processes for cleanup
const processes = [];

// Cleanup function
function cleanup() {
  console.log('\n🛑 Shutting down all services...');
  processes.forEach(proc => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
    }
  });
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start MCP Server
console.log('🔄 Starting MCP Server...');
const mcpServer = spawn('node', ['dist/cli.js'], {
  stdio: 'pipe',
  env: {
    ...process.env,
    TRANSPORT: 'http',
    HTTP_HOST: HOST,
    HTTP_PORT: MCP_PORT.toString()
  }
});

processes.push(mcpServer);

mcpServer.stdout.on('data', (data) => {
  console.log(`[MCP] ${data.toString().trim()}`);
});

mcpServer.stderr.on('data', (data) => {
  console.error(`[MCP ERROR] ${data.toString().trim()}`);
});

mcpServer.on('close', (code) => {
  console.log(`[MCP] Process exited with code ${code}`);
  if (code !== 0) {
    cleanup();
  }
});

// Start API Server
console.log('🔄 Starting API Server...');
const apiServer = spawn('node', ['apps/api/dist/server.js'], {
  stdio: 'pipe',
  env: {
    ...process.env,
    API_PORT: API_PORT.toString(),
    API_BIND: HOST
  }
});

processes.push(apiServer);

apiServer.stdout.on('data', (data) => {
  console.log(`[API] ${data.toString().trim()}`);
});

apiServer.stderr.on('data', (data) => {
  console.error(`[API ERROR] ${data.toString().trim()}`);
});

apiServer.on('close', (code) => {
  console.log(`[API] Process exited with code ${code}`);
  if (code !== 0) {
    cleanup();
  }
});

// Start Web UI Server (serve static files)
console.log('🔄 Starting Web UI Server...');
const webApp = express();

// Serve static files from the web build directory
webApp.use(express.static(join(__dirname, 'apps/web/dist')));

// Handle SPA routing - serve index.html for all non-API routes
webApp.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'apps/web/dist/index.html'));
});

const webServer = webApp.listen(WEB_PORT, HOST, () => {
  console.log(`✅ Web UI Server running on http://${HOST}:${WEB_PORT}`);
});

// Health check endpoint that checks all services
const healthApp = express();
healthApp.use(express.json());

healthApp.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      mcp: 'unknown',
      api: 'unknown',
      web: 'ok'
    }
  };

  // Check MCP server
  try {
    const mcpResponse = await fetch(`http://${HOST}:${MCP_PORT}/health`);
    health.services.mcp = mcpResponse.ok ? 'ok' : 'error';
  } catch (error) {
    health.services.mcp = 'error';
  }

  // Check API server
  try {
    const apiResponse = await fetch(`http://${HOST}:${API_PORT}/health`);
    health.services.api = apiResponse.ok ? 'ok' : 'error';
  } catch (error) {
    health.services.api = 'error';
  }

  // Overall status
  const allOk = Object.values(health.services).every(status => status === 'ok');
  health.status = allOk ? 'ok' : 'degraded';

  res.status(allOk ? 200 : 503).json(health);
});

// Add health endpoint to web server
webApp.use('/health', healthApp);

console.log('✅ All services started successfully!');
console.log('🔍 Use /health endpoint to check service status');

// Keep the process alive
process.stdin.resume();
