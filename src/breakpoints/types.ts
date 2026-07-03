import { Breakpoint } from '../ozone-backend/types';

export type BreakpointEventType = 'added' | 'removed' | 'changed' | 'hit';

export interface BreakpointEvent {
  type: BreakpointEventType;
  breakpoint: Breakpoint;
}