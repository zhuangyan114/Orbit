import { describe, expect, it } from 'vitest';
import {
  LEGACY_OZONE_DAP_TYPE,
  ORBIT_DAP_TYPE,
  isOrbitDebugSessionType,
} from './debug-session-type';

describe('Orbit DAP session type compatibility', () => {
  it('accepts the canonical Orbit type and the legacy Ozone alias', () => {
    expect(isOrbitDebugSessionType(ORBIT_DAP_TYPE)).toBe(true);
    expect(isOrbitDebugSessionType(LEGACY_OZONE_DAP_TYPE)).toBe(true);
    expect(isOrbitDebugSessionType('other-debugger')).toBe(false);
    expect(isOrbitDebugSessionType(undefined)).toBe(false);
  });
});
