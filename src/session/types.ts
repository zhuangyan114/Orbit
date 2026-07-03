import { DebugSessionConfig, TargetState } from '../ozone-backend/types';

export interface SessionInfo {
  id: string;
  config: DebugSessionConfig;
  state: TargetState;
  startedAt: number;
  label: string;
}

export interface RecentSession {
  config: DebugSessionConfig;
  label: string;
  lastUsed: number;
}