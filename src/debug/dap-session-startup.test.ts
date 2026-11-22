import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';
import { flashWithOpenOcd, RMLinkProbeHandoff } from '../ozone-backend/openocd-flasher';

vi.mock('../ozone-backend/openocd-flasher', async importOriginal => ({
  ...await importOriginal<typeof import('../ozone-backend/openocd-flasher')>(),
  flashWithOpenOcd: vi.fn(),
}));

const probes = ['jlink', 'cmsis-dap', 'rmlink'] as const;

function fixture(probe: typeof probes[number], entry?: string | false, flashBeforeDebug = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-startup-'));
  const program = path.join(dir, 'firmware.elf');
  fs.writeFileSync(program, 'firmware-v1');
  let state = 'halted';
  const execute = vi.fn(async (command: any): Promise<any> => {
    if (command.cmd === 'resolveProbe') return { ok: true, data: { probe } };
    if (command.cmd === 'connect') return { ok: true, data: { ownerKind: probe === 'jlink' ? 'jlink-native' : 'cmsis-dap' } };
    if (command.cmd === 'getTargetState') return { ok: true, data: state };
    if (command.cmd === 'run') { state = 'running'; return { ok: true, data: { state: 'Running' } }; }
    if (command.cmd === 'halt' || command.cmd === 'reset' || command.cmd === 'runToEntryPoint') state = 'halted';
    if (command.cmd === 'setBreakpoint') return { ok: true, data: { id: 2, address: 0x08000400 } };
    return { ok: true, data: { message: 'verified' } };
  });
  const session = new DapSession({ execute, configureNativeSteps: () => {}, dispose: vi.fn() } as unknown as OzoneBackend);
  const messages: DebugProtocolMessage[] = [];
  session.on('send', message => messages.push(message));
  const launch = (selectedProbe: string = probe, extra: Record<string, unknown> = {}) => (session as any).handleLaunch({
    type: 'request', seq: 1, command: 'launch', arguments: {
      probe: selectedProbe, program, device: 'STM32H723VG', flashBeforeDebug, rttLogEnabled: false,
      ...(entry === undefined ? {} : { runToEntryPoint: entry }),
      ...extra,
    },
  });
  const restart = () => (session as any).handleRestart({ type: 'request', seq: 2, command: 'restart', arguments: {} });
  const clean = () => {
    (session as any).stopPolling();
    (session as any).stopConnectionMonitor();
    (session as any).stopRttLogPolling();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { session, execute, messages, program, launch, restart, clean };
}

describe('shared startup and restart policy', () => {
  it.each(['auto', 'native'])('prefers the registered fast path with flashBackend=%s', async flashBackend => {
    const f = fixture('cmsis-dap');
    try {
      await f.launch('cmsis-dap', { flashBackend });
      expect(f.execute.mock.calls.map(([command]) => command.cmd).slice(0, 2)).toEqual(['connect', 'flash']);
      expect(f.messages.find(m => m.request_seq === 1)).toMatchObject({ success: true });
    } finally { f.clean(); }
  });

  it.each([
    { device: 'STM32H723VG', flashBackend: 'openocd' },
    { device: 'STM32F401CCU6' },
  ])('burns before connecting and relinquishes the current owner on changed restart for %j', async selection => {
    const f = fixture('cmsis-dap');
    const flash = vi.mocked(flashWithOpenOcd);
    flash.mockReset().mockResolvedValue({ ok: true, data: null });
    try {
      await f.launch('cmsis-dap', selection);
      expect(flash.mock.invocationCallOrder[0]).toBeLessThan(f.execute.mock.invocationCallOrder[0]!);
      expect(f.execute.mock.calls.map(([command]) => command.cmd)).not.toContain('flash');
      (f.session as any).rememberBreakpoint('main.c:42', 2, 0x08000400);
      await f.restart();
      expect(flash).toHaveBeenCalledTimes(1);
      fs.writeFileSync(f.program, 'firmware-v2');
      f.execute.mockClear();
      await f.restart();
      expect(f.execute.mock.calls.map(([command]) => command.cmd).slice(1, 3)).toEqual(['disconnect', 'connect']);
      expect(flash.mock.invocationCallOrder[1]).toBeGreaterThan(f.execute.mock.invocationCallOrder[1]!);
      expect(flash.mock.invocationCallOrder[1]).toBeLessThan(f.execute.mock.invocationCallOrder[2]!);
      expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'setBreakpoint', file: 'main.c', line: 42 }));
    } finally { f.clean(); }
  });

  it('releases RMLink before programming and restores the enhanced connection even on flash failure', async () => {
    const f = fixture('rmlink');
    const acquire = vi.fn();
    const release = vi.fn();
    const handoff = vi.spyOn(RMLinkProbeHandoff, 'prepare').mockResolvedValue({
      acquire, release, deviceId: 'b81f3fc30470',
      debugConfig: { cmsisDapTransport: 'tcp', cmsisDapPath: '127.0.0.1' },
    } as unknown as RMLinkProbeHandoff);
    const flash = vi.mocked(flashWithOpenOcd);
    flash.mockReset().mockResolvedValue({ ok: false, errorCode: 'OutcomeUnknown', error: 'flash outcome unknown' });
    try {
      await f.launch('rmlink', { flashBackend: 'openocd' });
      expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(flash.mock.invocationCallOrder[0]!);
      expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(flash.mock.invocationCallOrder[0]!);
      expect(f.execute.mock.calls.map(([command]) => command.cmd)).not.toContain('connect');
      expect(f.execute.mock.calls.map(([command]) => command.cmd)).not.toContain('flash');
      expect(f.messages.find(m => m.request_seq === 1)).toMatchObject({ success: false });
    } finally { handoff.mockRestore(); f.clean(); }
  });

  it('skips explicit OpenOCD when flashBeforeDebug is false', async () => {
    const f = fixture('cmsis-dap', 'main', false);
    const flash = vi.mocked(flashWithOpenOcd);
    flash.mockClear();
    try {
      await f.launch('cmsis-dap', { flashBackend: 'openocd' });
      expect(flash).not.toHaveBeenCalled();
      expect(f.execute.mock.calls.map(([command]) => command.cmd)).not.toContain('flash');
      expect(f.messages.find(m => m.request_seq === 1)).toMatchObject({ success: true });
    } finally { f.clean(); }
  });

  it.each(probes)('%s launches at main and restarts unchanged firmware directly', async probe => {
    const f = fixture(probe);
    try {
      await f.launch();
      expect(f.execute).toHaveBeenCalledWith({ cmd: 'runToEntryPoint', symbol: 'main', reset: true });
      (f.session as any).rememberBreakpoint('main.c:42', 2, 0x08000400);
      f.execute.mockClear(); f.messages.length = 0;
      // A timestamp-only rebuild must still count as unchanged.
      fs.utimesSync(f.program, new Date(), new Date(Date.now() + 10000));
      await f.restart();
      expect(f.messages.find(m => m.request_seq === 2)).toMatchObject({ success: true });
      const commands = f.execute.mock.calls.map(([c]) => c.cmd);
      expect(commands).toContain('reset');
      expect(commands).toContain('run');
      expect(commands).not.toContain('flash');
      expect(commands).not.toContain('runToEntryPoint');
      expect(f.messages.some(m => m.event === 'stopped')).toBe(false);
      const continued = f.messages.find(m => m.event === 'continued')!;
      expect(continued).toBeDefined();
      expect(f.messages.indexOf(continued)).toBeGreaterThan(f.messages.findIndex(m => m.request_seq === 2));
      expect((f.session as any).targetRunning).toBe(true);
      expect((f.session as any).breakpoints.has('main.c:42')).toBe(true);
    } finally { f.clean(); }
  });

  it.each(probes)('%s reloads changed symbols and stops at the configured entry', async probe => {
    const f = fixture(probe, ' app_main ');
    try {
      await f.launch();
      (f.session as any).rememberBreakpoint('main.c:42', 2, 0x08000300);
      f.execute.mockClear(); f.messages.length = 0;
      fs.writeFileSync(f.program, 'firmware-v2');
      await f.restart();
      const commands = f.execute.mock.calls.map(([c]) => c.cmd);
      expect(commands).toContain('flash');
      expect(commands.indexOf('loadSymbols')).toBeGreaterThan(commands.indexOf('flash'));
      expect(commands.indexOf('runToEntryPoint')).toBeGreaterThan(commands.indexOf('loadSymbols'));
      expect(f.execute).toHaveBeenCalledWith({ cmd: 'runToEntryPoint', symbol: 'app_main', reset: true });
      expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'setBreakpoint', file: 'main.c', line: 42 }));
      expect(f.messages.find(m => m.event === 'stopped')).toMatchObject({ body: { reason: 'entry' } });
      expect(f.messages.some(m => m.event === 'continued')).toBe(false);
      expect(f.messages.find(m => m.request_seq === 2)).toMatchObject({ success: true });
      f.execute.mockClear(); f.messages.length = 0;
      await f.restart();
      expect(f.execute.mock.calls.map(([c]) => c.cmd)).not.toContain('flash');
      expect(f.execute.mock.calls.map(([c]) => c.cmd)).not.toContain('runToEntryPoint');
      expect(f.messages.some(m => m.event === 'continued')).toBe(true);
    } finally { f.clean(); }
  });

  it('preserves a custom entry when auto discovery selects J-Link', async () => {
    const f = fixture('jlink', 'app_main');
    try {
      await f.launch('auto');
      expect(f.execute).toHaveBeenCalledWith({ cmd: 'runToEntryPoint', symbol: 'app_main', reset: true });
    } finally { f.clean(); }
  });

  it.each(probes)('%s honors disabled startup stops', async probe => {
    const f = fixture(probe, false);
    try {
      await f.launch();
      expect(f.execute.mock.calls.some(([c]) => c.cmd === 'runToEntryPoint')).toBe(false);
    } finally { f.clean(); }
  });

  it.each(probes)('%s restarts an unchanged no-flash session directly without programming', async probe => {
    const f = fixture(probe, 'main', false);
    try {
      await f.launch();
      f.execute.mockClear();
      await f.restart();
      expect(f.execute.mock.calls.map(([c]) => c.cmd)).toContain('run');
      expect(f.execute.mock.calls.map(([c]) => c.cmd)).not.toContain('flash');
      expect(f.execute.mock.calls.map(([c]) => c.cmd)).not.toContain('runToEntryPoint');
    } finally { f.clean(); }
  });

  it.each(['reset', 'run', 'getTargetState'])('does not report a successful restart when %s fails', async operation => {
    const f = fixture('cmsis-dap');
    try {
      await f.launch();
      f.messages.length = 0;
      const execute = f.execute.getMockImplementation()!;
      f.execute.mockImplementation(async command => command.cmd === operation
        ? { ok: false, error: 'DeviceRemoved: disconnected', errorCode: 'DeviceRemoved' }
        : execute(command));
      await f.restart();
      expect(f.messages.find(m => m.request_seq === 2)).toMatchObject({ success: false });
      expect(f.messages.some(m => m.event === 'continued')).toBe(false);
      expect((f.session as any).controlInProgress).toBe(false);
    } finally { f.clean(); }
  });

  it('reports a real user breakpoint reached immediately after restart', async () => {
    const f = fixture('cmsis-dap');
    try {
      await f.launch();
      f.messages.length = 0;
      const execute = f.execute.getMockImplementation()!;
      f.execute.mockImplementation(async command => command.cmd === 'run'
        ? { ok: true, data: { state: 'Halted', breakpointHitBeforeRunningObserved: true } }
        : execute(command));
      await f.restart();
      expect(f.messages.filter(m => m.event === 'continued' || m.event === 'stopped').map(m => [m.event, m.body?.reason]))
        .toEqual([['continued', undefined], ['stopped', 'breakpoint']]);
      expect(f.messages.find(m => m.request_seq === 2)).toMatchObject({ success: true });
    } finally { f.clean(); }
  });

  it.each(probes)('%s restores user breakpoints when the changed firmware cannot reach its entry', async probe => {
    const f = fixture(probe);
    try {
      await f.launch();
      (f.session as any).rememberBreakpoint('main.c:42', 2, 0x08000300);
      f.messages.length = 0;
      fs.writeFileSync(f.program, 'firmware-v2');
      const execute = f.execute.getMockImplementation()!;
      f.execute.mockImplementation(async command => command.cmd === 'runToEntryPoint'
        ? { ok: false, error: 'StartupEntryNotReached: timed out', errorCode: 'StartupEntryNotReached' }
        : execute(command));
      await f.restart();
      expect(f.messages.find(m => m.request_seq === 2)).toMatchObject({ success: false });
      expect((f.session as any).breakpointAddresses.get('main.c:42')).toBe(0x08000400);
      expect(f.messages.some(m => m.event === 'continued')).toBe(false);
    } finally { f.clean(); }
  });
});
