# Timeline History Replay Design

## Context

Timeline retains up to ten minutes of samples in the extension host. During an active Orbit DAP session, those ten minutes use the existing logical sampling clock: target Halted time does not advance sample timestamps, produce points, or age retained points out of the window.

When the Timeline webview is recreated after switching to another view, `TimelineWebviewProvider` sends the retained history back as a `samples` message. At sustained sampling rates, one expression can contain hundreds of thousands of points.

## Root Cause

The webview merges incoming history in two stages:

1. `TimelineFrameBatcher.enqueue` appends a snapshot to its pending frame.
2. `appendTimelineSamples` appends the flushed frame to the rendered history.

Both stages use `Array.push(...points)`. JavaScript treats the spread values as function arguments, so a sufficiently large retained history exceeds the engine's argument limit and throws `RangeError: Maximum call stack size exceeded`. The failed replay leaves the new webview without its previous points. Later live batches are small and continue to render, while reopening Timeline repeats the failed large replay until the VS Code window is reloaded and the extension-host history is reset.

## Decision

Replace both variadic array appends in `src/webview/timeline/timeline-sample-buffer.ts` with stack-safe appends whose cost depends on the number of points but not on the JavaScript function-argument limit.

Keep all surrounding contracts unchanged:

- Retain the ten-minute history duration.
- Keep Halted time excluded from the active DAP Timeline clock.
- Keep sampling and webview send intervals unchanged.
- Keep the existing `samples` message shape, animation-frame batching, trimming, auto-follow, and drawing behavior.
- Do not change target ownership, DAP routing, scheduler priorities, or native helper behavior.

Provider-side message chunking and forced webview context retention are not part of this fix. Chunking adds ordering and lifecycle complexity, while context retention only reduces how often replay occurs and does not remove the unsafe append.

## Data Flow

After the change, webview initialization remains:

1. The webview posts `init`.
2. The provider posts entry state and retained sample snapshots.
3. `TimelineFrameBatcher` safely accumulates the snapshots until the next animation frame.
4. `appendTimelineSamples` safely appends the flushed points and applies the existing ten-minute trim.
5. Canvas rendering continues from the restored latest timestamp, and subsequent live batches append normally.

No new error fallback is required because the fix removes the known synchronous `RangeError` at its source. Existing invalid or empty snapshots continue to be ignored.

## Tests

Extend `src/webview/timeline/timeline-sample-buffer.test.ts` before changing production code:

- Enqueue and flush a single history snapshot of about 250,000 points through `TimelineFrameBatcher`; current code must fail with the argument-limit error, while fixed code must flush every point in order.
- Append a history snapshot of about 250,000 points through `appendTimelineSamples`; current code must fail, while fixed code must retain the expected points and latest timestamp.
- Keep the existing small-batch coalescing, disposal, ordering, and history-trimming tests passing.

Run the focused Timeline tests first, followed by the full Vitest suite, typecheck, build, and `git diff --check`. Real hardware validation remains a separate user-driven check because automated tests do not exercise VS Code webview destruction and recreation against a physical target.

## Risks And Rollback

The large replay still performs linear work and retains the same memory footprint; this fix only removes the stack/argument-limit failure. The focused large-history tests guard correctness and provide a basic performance regression signal without changing retention policy.

Rollback consists of reverting the Timeline sample-buffer implementation and its new regression tests. No persisted state or protocol migration is introduced.

## Acceptance Criteria

- After enough samples accumulate to exceed the previous spread-argument limit, switching from Timeline to Terminal and back restores all retained points.
- Repeating the view switch does not clear history, and new live points continue to append.
- A target Halted interval does not consume the ten-minute Timeline history window.
- Existing Timeline sampling, trimming, rendering, and DAP behavior remain unchanged.
