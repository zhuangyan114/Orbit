#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const EXTENSION_IDS = [
  'orbit-debug.orbit-for-vscode',
];
const ENDPOINT_FILE = 'plugin-api-endpoint.json';

function defaultEndpointPath() {
  const configured = process.env.ORBIT_PLUGIN_API_ENDPOINT_FILE || process.env.OZONE_PLUGIN_API_ENDPOINT_FILE;
  if (configured) return configured;

  let storageRoot;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    storageRoot = path.join(appData, 'Code', 'User', 'globalStorage');
  } else if (process.platform === 'darwin') {
    storageRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    storageRoot = path.join(configHome, 'Code', 'User', 'globalStorage');
  }

  const candidates = EXTENSION_IDS.map(id => path.join(storageRoot, id, ENDPOINT_FILE));
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function readEndpoint() {
  const endpointPath = defaultEndpointPath();
  if (!fs.existsSync(endpointPath)) {
    throw new Error(`Orbit plugin API endpoint file not found: ${endpointPath}`);
  }

  const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
  if (!endpoint.url || !endpoint.token) {
    throw new Error(`Invalid Orbit plugin API endpoint file: ${endpointPath}`);
  }
  return endpoint;
}

async function callOrbit(method, params = {}) {
  const endpoint = readEndpoint();
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params,
    }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from Orbit plugin API: ${text}`);
  }

  if (!response.ok) {
    throw new Error(payload.error || `Orbit plugin API HTTP ${response.status}`);
  }
  if (!payload.ok) {
    throw new Error(payload.error || `Orbit plugin API call failed: ${method}`);
  }
  return payload.data;
}

function toolResult(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

const SignalSpec = z.object({
  alias: z.string().optional(),
  expression: z.string(),
  role: z.string().optional(),
  unit: z.string().optional(),
  writable: z.boolean().optional(),
});

const WriteSpec = z.object({
  alias: z.string().optional(),
  expression: z.string(),
  value: z.number(),
  address: z.number().int().min(0).max(0xFFFFFFFF).optional(),
  typeName: z.string().min(1).optional(),
});

const SafetyRule = z.object({
  expression: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const ExperimentStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), signals: z.array(SignalSpec) }),
  z.object({ type: z.literal('write'), writes: z.array(WriteSpec) }),
  z.object({ type: z.literal('wait'), durationMs: z.number() }),
  z.object({
    type: z.literal('record'),
    recordingId: z.string().optional(),
    durationMs: z.number(),
    intervalMs: z.number().optional(),
    channels: z.array(SignalSpec),
  }),
]);

const server = new McpServer({
  name: 'orbit-debug-mcp',
  version: '0.2.0',
});

server.registerTool(
  'ozone_status',
  {
    title: 'Get Orbit target status',
    description: 'Returns the current Orbit plugin API and target state.',
    inputSchema: {},
  },
  async () => toolResult(await callOrbit('ozone.status'))
);

server.registerTool(
  'ozone_read_many',
  {
    title: 'Read target expressions',
    description: 'Reads one or more debugger expressions from the active Orbit debug session.',
    inputSchema: {
      expressions: z.array(z.string()).optional(),
      signals: z.array(SignalSpec).optional(),
    },
  },
  async args => toolResult(await callOrbit('ozone.expr.readMany', args))
);

server.registerTool(
  'ozone_write_many',
  {
    title: 'Write target expressions',
    description: 'Writes numeric values to one or more debugger expressions.',
    inputSchema: {
      writes: z.array(WriteSpec),
    },
  },
  async args => toolResult(await callOrbit('ozone.expr.writeMany', args))
);

server.registerTool(
  'ozone_record',
  {
    title: 'Record target waveforms',
    description: 'Records synchronized frames for arbitrary target expressions and returns the captured data.',
    inputSchema: {
      durationMs: z.number(),
      intervalMs: z.number().optional(),
      channels: z.array(SignalSpec),
    },
  },
  async args => {
    const started = await callOrbit('ozone.record.start', args);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, args.durationMs) + 100));
    const recording = await callOrbit('ozone.record.get', { recordingId: started.recordingId });
    await callOrbit('ozone.record.clear', { recordingId: started.recordingId });
    return toolResult(recording);
  }
);

server.registerTool(
  'ozone_experiment_run',
  {
    title: 'Run a generic Orbit experiment',
    description: 'Runs read/write/wait/record steps against the target. The caller decides which expressions to use.',
    inputSchema: {
      name: z.string().optional(),
      baseline: z.array(SignalSpec).optional(),
      steps: z.array(ExperimentStep),
      safety: z.array(SafetyRule).optional(),
    },
  },
  async args => toolResult(await callOrbit('ozone.experiment.run', args))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error(`[ozone-mcp] ${err?.stack || err?.message || err}`);
  process.exit(1);
});
