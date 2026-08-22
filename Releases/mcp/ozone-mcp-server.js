#!/usr/bin/env node

// Compatibility launcher. The Automation API v1 adapter lives in orbit-mcp-server.js.
const { startStdio } = require('./orbit-mcp-server.js');

startStdio().catch(err => {
  console.error(`[orbit-mcp] ${err?.stack || err?.message || err}`);
  process.exit(1);
});
