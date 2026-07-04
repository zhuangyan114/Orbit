import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { OzoneBackend } from '../ozone-backend/commander';
import { ExperimentService } from './experiment-service';
import { RuntimeRouter } from './runtime-router';
import {
  ApiEndpointInfo,
  JsonRpcRequest,
  JsonRpcResponse,
  ReadManyParams,
  RecordClearParams,
  RecordGetParams,
  RecordStartParams,
  RecordStopParams,
  SignalSpec,
  WriteManyParams,
} from './types';
import { WaveRecorder } from './wave-recorder';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const ENDPOINT_FILE = 'plugin-api-endpoint.json';

export class PluginApiServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString('hex');
  private runtime: RuntimeRouter;
  private recorder: WaveRecorder;
  private experiment: ExperimentService;

  constructor(private context: vscode.ExtensionContext, backend: OzoneBackend) {
    this.runtime = new RuntimeRouter(backend);
    this.recorder = new WaveRecorder(this.runtime);
    this.experiment = new ExperimentService(this.runtime, this.recorder);
  }

  async start(): Promise<ApiEndpointInfo> {
    if (this.server) return this.endpointInfo();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, HOST, () => resolve());
    });

    const info = this.endpointInfo();
    await this.writeEndpointInfo(info);
    return info;
  }

  getEndpointInfo(): ApiEndpointInfo {
    return this.endpointInfo();
  }

  dispose() {
    this.recorder.dispose();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      this.writeJson(res, 200, { ok: true, data: { status: 'ready' } });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      this.writeJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    try {
      const body = await this.readBody(req);
      const request = JSON.parse(body) as JsonRpcRequest;
      const response = await this.handleRpc(request);
      this.writeJson(res, 200, response);
    } catch (err: any) {
      this.writeJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
  }

  private async handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      if (!request || typeof request.method !== 'string') {
        throw new Error('RPC method is required');
      }

      const data = await this.dispatch(request.method, request.params);
      return { id: request.id, ok: true, data };
    } catch (err: any) {
      return { id: request?.id, ok: false, error: err?.message || String(err) };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ozone.status':
        return { targetState: await this.runtime.getTargetState() };
      case 'ozone.target.getState':
        return { state: await this.runtime.getTargetState() };
      case 'ozone.expr.readMany':
        return { results: await this.runtime.readSignals(this.readManySignals(params as ReadManyParams)) };
      case 'ozone.expr.writeMany':
        return { results: await this.runtime.writeMany((params as WriteManyParams)?.writes || []) };
      case 'ozone.record.start':
        return this.recorder.start(params as RecordStartParams);
      case 'ozone.record.stop':
        return this.recorder.stop(params as RecordStopParams);
      case 'ozone.record.get':
        return this.recorder.get((params as RecordGetParams).recordingId);
      case 'ozone.record.clear':
        return this.recorder.clear((params as RecordClearParams) || {});
      case 'ozone.experiment.run':
        return this.experiment.run(params as any);
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }

  private readManySignals(params: ReadManyParams): SignalSpec[] {
    if (Array.isArray(params?.signals)) return params.signals;
    if (Array.isArray(params?.expressions)) {
      return params.expressions.map(expression => ({ alias: expression, expression }));
    }
    throw new Error('readMany requires signals or expressions');
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization || '';
    return header === `Bearer ${this.token}`;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let length = 0;
      req.setEncoding('utf8');
      req.on('data', chunk => {
        length += Buffer.byteLength(chunk);
        if (length > MAX_BODY_BYTES) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private endpointInfo(): ApiEndpointInfo {
    if (!this.server) throw new Error('Plugin API server is not running');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Plugin API server address unavailable');
    return {
      host: HOST,
      port: address.port,
      token: this.token,
      url: `http://${HOST}:${address.port}/rpc`,
      updatedAt: Date.now(),
    };
  }

  private async writeEndpointInfo(info: ApiEndpointInfo): Promise<void> {
    const dir = this.context.globalStorageUri.fsPath;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ENDPOINT_FILE), JSON.stringify(info, null, 2), 'utf8');
  }

  private writeJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private setCorsHeaders(res: http.ServerResponse) {
    res.setHeader('access-control-allow-origin', 'http://127.0.0.1');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
  }
}
