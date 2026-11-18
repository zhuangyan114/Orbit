import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('vscode', () => ({
  ConfigurationTarget: { WorkspaceFolder: 3, Workspace: 2, Global: 1 },
  workspace: {
    getConfiguration: vi.fn(() => ({
      inspect: vi.fn(() => undefined),
      update: vi.fn(async () => {}),
    })),
  },
}));

import { ORBIT_SETTING_KEYS } from './orbit-settings';

describe('Orbit settings surface', () => {
  it('retains defaultRtos and excludes removed mcu-debug.rtos-views auto-refresh setting', () => {
    expect(ORBIT_SETTING_KEYS).toContain('defaultRtos');
    expect(ORBIT_SETTING_KEYS as readonly string[]).not.toContain('rtosViewsAutoRefresh');

    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    const props = pkg.contributes?.configuration?.properties ?? {};
    expect(props['orbit.defaultRtos']).toBeDefined();
    expect(props['orbit.rtosViewsAutoRefresh']).toBeUndefined();
  });

  it('does not inject mcu-debug.rtos-views.trackDebuggers in extension activation or helper', () => {
    const extensionSrc = readFileSync(resolve(__dirname, '../extension.ts'), 'utf8');
    expect(extensionSrc).not.toContain('mcu-debug.rtos-views');
    expect(extensionSrc).not.toContain('rtos-views-tracker');
    expect(extensionSrc).not.toContain('rtosViewsAutoRefresh');
    expect(extensionSrc).toContain('memory-view');
    expect(extensionSrc).toContain('mcu-debug.debug-tracker-vscode');
  });
});
