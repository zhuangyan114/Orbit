# Timeline Lazy Range Loading Design

## Context

The extension host retains ten minutes of Timeline samples. Recreating the Timeline webview currently serializes and sends every retained point before the view can render, so switching back from another VS Code view becomes slow as history grows. Sampling itself must continue while Timeline is hidden, and all retained history must remain accessible by panning or zooming.

## Decision

Keep the full ten-minute history in `DataSamplingManager`, retain the Timeline webview while hidden, and transfer raw samples to the webview by requested time range.

For a visible range `[viewStart, viewEnd]` with width `W`, request `[viewStart - 2W, viewEnd + 2W]`. Clamp both ends to the extension-side history bounds. Refill this buffer only when less than `0.5W` remains on either side of the visible range. In auto-follow mode the upper end therefore stops at the latest sample instead of requesting future time. Include at most one predecessor point per expression so traces remain continuous at the requested lower boundary.

The webview keeps live sample delivery while visible. While hidden, the provider does not post sample batches because hidden retained webview scripts may be suspended; `DataSamplingManager` continues sampling and retaining data. When the view becomes visible again, the provider sends lightweight current history bounds and the webview requests the missing buffered range.

## Protocol And State

- `init` returns entries, saved view state, and current `historyBounds`, but no full history payload.
- `loadRange` carries a monotonically increasing request id plus clamped `start` and `end` timestamps.
- `rangeSamples` echoes the request id and range and contains per-expression snapshots selected with binary search.
- `historyBounds` tells a retained webview that the oldest/latest host timestamps changed after a hidden interval.
- Live `samples` messages remain unchanged and continue to append in real time while the view is visible.

The webview tracks requested coverage and merges overlapping range/live samples in timestamp order without duplicates. A stale range response may fill cache data but must not move the current viewport or override newer bounds. Range checks are debounced during drag/zoom; they refill the 2-screen buffer when the remaining margin drops below 0.5 screen.

## Boundaries

- Empty history produces no range request and an empty range response.
- Requested start/end are normalized and clamped to retained history; a fully out-of-history request returns no points.
- Each expression can have missing timestamps. Coverage is a requested time interval, not inferred from whether every expression returned points.
- History trimming may advance the oldest bound between request and response. The provider slices the current array at response time and reports the actual clamped range.
- `clearData`, expression removal, and webview recreation reset client coverage and cached samples.
- The webview buffer remains bounded by the same ten-minute trim and can eventually contain all ten minutes only when the user actually views those ranges.

## Unchanged Contracts

- Ten minutes of effective target-running history remain available.
- Halted time remains excluded from the DAP logical sampling clock.
- Sampling cadence, DAP routing, owner selection, scheduler priority, and native helpers do not change.
- Wide views still request all raw points they genuinely cover; existing canvas pixel-column reduction limits rendering work.
- Generated `dist/` files are not edited manually.

## Tests

Add pure tests for 0.5-screen prefetch calculation, clamping at both history edges, binary-search slicing with one predecessor, and sorted overlap deduplication. Add provider/data-manager-facing tests for empty ranges and current bounds where practical. Keep the existing 250,000-point replay regressions, Timeline trace tests, full Vitest suite, typecheck, and build passing.

Real VS Code acceptance remains user-driven: sample for several minutes, repeatedly switch Timeline/Terminal, confirm immediate return and real-time updates, then pan/zoom to both ten-minute boundaries.

## Risks And Rollback

The main risks are duplicate points where live and range messages overlap, stale responses after rapid zooming, and blank edges when retention advances. Ordered deduplication, request ids, coverage reset rules, and clamped range tests address those risks. Rollback removes the range protocol and `retainContextWhenHidden`, restoring full replay without changing persisted data.
