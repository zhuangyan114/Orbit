import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: spawnMock }));

import { cancelActiveFlashes, flashElf } from './flasher';

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('flashElf process lifecycle', () => {
  let tempDir: string;
  let elfPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-flasher-test-'));
    elfPath = path.join(tempDir, 'frame.elf');
    fs.writeFileSync(elfPath, 'test');
  });

  afterEach(() => {
    cancelActiveFlashes('test cleanup');
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawns the real executable directly and kills that child on timeout', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);

    const flashing = flashElf(elfPath, 'STM32F407IG', 'SWD', 4000, { timeoutMs: 50, jlinkPath: process.execPath });
    await vi.advanceTimersByTimeAsync(50);
    const result = await flashing;

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['-device', 'STM32F407IG', '-CommanderScript']),
      { shell: false, windowsHide: true },
    );
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result).toMatchObject({ success: false, message: 'Flash timeout (0s)' });
  });

  it('aborts an active flash when the DAP session is disposed', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();

    const flashing = flashElf(elfPath, 'STM32F407IG', 'SWD', 4000, {
      signal: controller.signal,
      timeoutMs: 30000,
      jlinkPath: process.execPath,
    });
    controller.abort('DAP session disposed');
    const result = await flashing;

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.message).toContain('Flash cancelled: DAP session disposed');
  });

  it('clears the timeout after a successful J-Link exit', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);

    const flashing = flashElf(elfPath, 'STM32F407IG', 'SWD', 4000, { timeoutMs: 50, jlinkPath: process.execPath });
    child.stdout.emit('data', Buffer.from('Download verified O.K.'));
    child.exitCode = 0;
    child.emit('exit', 0);
    const result = await flashing;
    await vi.advanceTimersByTimeAsync(100);

    expect(result.success).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
