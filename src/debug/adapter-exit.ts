/**
 * Owns the debug adapter's exit sequence.
 *
 * The adapter process holds the physical probe for its session, so every
 * shutdown trigger (DAP shutdown, stdin end, SIGINT/SIGTERM, unhandled
 * rejection) must end in `process.exit()` even when session disposal rejects or
 * never settles. A stranded adapter keeps the target claimed, and the next
 * debug launch then waits on the probe until its own flash timeout expires.
 */
export interface AdapterExitDeps {
  /** Awaited before exiting. A rejection is logged, never propagated. */
  dispose: () => Promise<void>;
  /** Best-effort stdout flush so the last DAP frame reaches VS Code. */
  flushStdout: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  /** Hard bound on the whole cleanup. Defaults to 4000 ms. */
  forceExitMs?: number;
}

const DEFAULT_FORCE_EXIT_MS = 4000;

/**
 * Returns an idempotent exit function: the first call owns the cleanup and
 * every later call reuses that same promise, so repeated signals cannot restart
 * or cancel the sequence.
 */
export function createAdapterExit(deps: AdapterExitDeps): (code: number) => Promise<void> {
  const forceExitMs = deps.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;
  let exitPromise: Promise<void> | null = null;

  return (code: number) => {
    if (exitPromise) return exitPromise;
    exitPromise = (async () => {
      const watchdog = setTimeout(() => deps.exit(code), forceExitMs);
      try {
        await deps.dispose();
        await deps.flushStdout();
      } catch (error) {
        deps.log(`debugadapter dispose failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(watchdog);
      }
      deps.exit(code);
    })();
    return exitPromise;
  };
}
