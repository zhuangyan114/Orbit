export interface RtosViewsTrackerEvent {
  event?: string;
  sessionId?: string;
}

/**
 * Build a debug-tracker callback that always returns a Promise, as required by
 * debug-tracker-vscode's client dispatch contract.
 */
export function createRtosViewsRefreshHandler(onFirstStackTrace: () => void): (event: RtosViewsTrackerEvent) => Promise<void> {
  let scheduledSessionId: string | undefined;

  return async (event: RtosViewsTrackerEvent): Promise<void> => {
    if (event.event === 'first-stack-trace' && event.sessionId !== scheduledSessionId) {
      scheduledSessionId = event.sessionId;
      onFirstStackTrace();
    }
  };
}
