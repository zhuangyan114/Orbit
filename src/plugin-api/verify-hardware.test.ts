import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const hardware = require('../../scripts/automation-api/verify-hardware.js') as {
  CONTROL_OVERHEAD_P95_MS: number;
  RPC_DISPATCH_P95_MS: number;
  SSE_WRITE_P95_MS: number;
  WORKFLOW_STEPS: string[];
  classifyLayerStatus(input: {
    automated?: string;
    mock?: string;
    hardware?: Record<string, string>;
  }): Record<string, string>;
  evaluatePerformanceGate(samples: number[], limitMs: number, options?: { previousP95?: number; jitter?: number }): {
    count: number;
    p50: number;
    p95: number;
    max: number;
    passed: boolean;
    jitterOk: boolean;
  };
  percentileStats(values: number[]): { count: number; p50: number; p95: number; max: number };
  redactSecrets(value: unknown): unknown;
  validateAuthorization(options: Record<string, unknown>): string[];
  validateHardwareEvidence(evidence: Record<string, unknown>): string[];
  continueSucceeded(data: { state?: string; stopReason?: string; session?: { stopReason?: string } } | undefined): boolean;
  defaultConfiguration(options: Record<string, unknown>): string;
};

describe('Orbit Automation API hardware acceptance validator', () => {
  it('refuses target-mutating live runs without explicit probe, board, and authorize', () => {
    expect(hardware.validateAuthorization({ mode: 'live' })).toEqual(expect.arrayContaining([
      'live hardware mutation requires --authorize',
      'live hardware mutation requires --probe',
      'live hardware mutation requires --board',
    ]));
    expect(hardware.validateAuthorization({
      mode: 'live',
      authorize: true,
      probe: 'jlink-native',
      board: 'STM32F407VET6',
      operations: ['pause'],
    })).toEqual([]);
  });

  it('never marks a missing hardware layer as passed', () => {
    const status = hardware.classifyLayerStatus({
      automated: 'passed',
      mock: 'passed',
    });
    expect(status.automated).toBe('passed');
    expect(status.mock).toBe('passed');
    expect(status['hardware.jlink-native']).toBe('unverified');
    expect(status['hardware.jlink-legacy']).toBe('unverified');
    expect(status['hardware.cmsis-dap']).toBe('unverified');
    expect(status.allLayersPassed).toBe('false');
  });

  it('rejects evidence that claims hardware passed without authorized requests or a single owner', () => {
    const violations = hardware.validateHardwareEvidence({
      schemaVersion: 1,
      layers: {
        automated: 'passed',
        mock: 'passed',
        'hardware.jlink-native': 'passed',
      },
      owners: { maxConcurrent: 2, kinds: ['jlink-native', 'cmsis-dap'], helperPids: [1, 2] },
      requests: [{ method: 'orbit.target.pause', token: 'secret-token' }],
    });
    expect(violations).toEqual(expect.arrayContaining([
      'hardware.jlink-native is marked passed without authorized evidence',
      'target owner maxConcurrent must be 1',
      'evidence must not contain a bearer token',
    ]));
  });

  it('computes p95 gates and allows 5 percent jitter across two release rounds', () => {
    expect(hardware.RPC_DISPATCH_P95_MS).toBe(20);
    expect(hardware.SSE_WRITE_P95_MS).toBe(100);
    expect(hardware.CONTROL_OVERHEAD_P95_MS).toBe(50);
    const samples = Array.from({ length: 100 }, (_, index) => (index >= 94 ? 19 : 10));
    const first = hardware.evaluatePerformanceGate(samples, 20);
    expect(first.passed).toBe(true);
    expect(first.p95).toBe(19);
    const second = hardware.evaluatePerformanceGate(samples.map(value => value * 1.04), 20, {
      previousP95: first.p95,
      jitter: 0.05,
    });
    expect(second.jitterOk).toBe(true);
    const drifted = hardware.evaluatePerformanceGate(samples.map(value => value * 1.2), 20, {
      previousP95: first.p95,
      jitter: 0.05,
    });
    expect(drifted.jitterOk).toBe(false);
  });

  it('redacts tokens from nested evidence and covers the frozen hardware workflow', () => {
    expect(hardware.redactSecrets({
      token: 'abc',
      authorization: 'Bearer abc',
      nested: { token: 'abc', rpcUrl: 'http://127.0.0.1:1/v1/rpc' },
    })).toEqual({
      token: '[redacted]',
      authorization: '[redacted]',
      nested: { token: '[redacted]', rpcUrl: 'http://127.0.0.1:1/v1/rpc' },
    });
    expect(hardware.WORKFLOW_STEPS).toEqual(expect.arrayContaining([
      'handshake', 'visible-start', 'breakpoint-add', 'breakpoint-hit', 'breakpoint-remove',
      'pause', 'continue', 'reset', 'stepInstruction', 'stepInto', 'stepOver', 'stepOut',
      'flash', 'symbol-search', 'symbol-resolve', 'variable-read', 'variable-write',
      'memory-read', 'memory-write', 'watch-sync', 'timeline-sync', 'record', 'rtt',
      'diagnostics', 'sse-lifecycle', 'stop', 'owner-count-1', 'disconnect-cleanup',
    ]));
  });

  it('accepts continue that settles on a breakpoint before the RPC returns', () => {
    expect(hardware.continueSucceeded({ state: 'running' })).toBe(true);
    expect(hardware.continueSucceeded({ state: 'halted', stopReason: 'breakpoint' })).toBe(true);
    expect(hardware.continueSucceeded({ state: 'halted', session: { stopReason: 'breakpoint' } })).toBe(true);
    expect(hardware.continueSucceeded({ state: 'halted', stopReason: 'pause' })).toBe(false);
    expect(hardware.continueSucceeded({ state: 'unknown' })).toBe(false);
    expect(hardware.continueSucceeded(undefined)).toBe(false);
  });

  it('picks the probe-specific no-flash launch configuration by default', () => {
    expect(hardware.defaultConfiguration({ probe: 'cmsis-dap' })).toBe('Orbit: DAPLink (No Flash)');
    expect(hardware.defaultConfiguration({ probe: 'cmsis-dap', flash: true })).toBe('Orbit: DAPLink (Flash)');
    expect(hardware.defaultConfiguration({ probe: 'jlink-native' })).toBe('Orbit: J-Link (No Flash)');
    expect(hardware.defaultConfiguration({ configuration: 'Custom' })).toBe('Custom');
  });

  it('registers the hardware acceptance npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['test:automation-hardware']).toBe('node scripts/automation-api/verify-hardware.js --mock');
  });
});
