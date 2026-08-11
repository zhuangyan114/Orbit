export const ORBIT_DAP_TYPE = 'orbit' as const;
export const LEGACY_OZONE_DAP_TYPE = 'ozone' as const;

export type OrbitDebugSessionType = typeof ORBIT_DAP_TYPE | typeof LEGACY_OZONE_DAP_TYPE;

export function isOrbitDebugSessionType(type: unknown): type is OrbitDebugSessionType {
  return type === ORBIT_DAP_TYPE || type === LEGACY_OZONE_DAP_TYPE;
}
