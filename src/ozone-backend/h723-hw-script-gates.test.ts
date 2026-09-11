import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = path.resolve(__dirname, '..', '..');
const scripts: Array<{ file: string; missing: string; extra?: string[]; dir?: string }> = [
  { file: 'verify-h723-identity-hw.js', missing: '--hardware' },
  { file: 'verify-h723-ram-stub-hw.js', missing: '--authorize-ram-write', extra: ['--hardware'] },
  { file: 'verify-h723-algorithm-init-hw.js', missing: '--authorize-algorithm-init', extra: ['--hardware'] },
  { file: 'verify-h723-sector-hw.js', missing: '--authorize-test-sector', extra: ['--hardware'] },
  { file: 'verify-h723-flash-elf-hw.js', missing: '--authorize-flash-elf', extra: ['--hardware'] },
  { file: 'verify-h723-flash-elf-hw.js', missing: '--hardware' },
  { file: 'verify-h723-jlink-hw.js', missing: '--hardware', dir: 'jlink' },
  { file: 'verify-h723-jlink-hw.js', missing: '--authorize-flash-jlink', extra: ['--hardware'], dir: 'jlink' },
];

describe('H723 P7 hardware script authorization gates', () => {
  for (const script of scripts) {
    it(`refuses ${script.file} without ${script.missing}`, () => {
      const result = spawnSync(process.execPath, [
        path.join(workspace, 'scripts', script.dir || 'cmsis-dap', script.file),
        ...(script.extra || []),
      ], {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status).toBe(2);
      expect(`${result.stdout}\n${result.stderr}`).toContain(script.missing);
    });
  }
});
