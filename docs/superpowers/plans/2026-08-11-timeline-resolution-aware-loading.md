# Timeline Resolution-Aware Loading Implementation Plan

**Date:** 2026-08-11

## Goal

Keep Timeline sampling active and retain the latest ten minutes in the extension host while making pan, zoom, view switching, and live-follow responsive. The webview must never receive or merge a full raw history range when the display can represent only a few thousand pixels.

## Confirmed Behavior

- Sampling continues while the Timeline view is hidden and while the target is running.
- The extension host retains the latest ten minutes of samples.
- A viewport keeps two viewport widths of prefetched data on both sides when history bounds allow it.
- A refill starts when less than half a viewport width remains on either side.
- Range data is loaded at a resolution derived from the plot width and requested time span.
- Live samples continue to update the right edge without waiting for a range reload.
- A sampling pause, restart, or large timestamp gap starts a new trace segment; the renderer must not connect the gap with a long line.
- The Timeline webview context is retained while hidden.

## Root Cause

The host currently slices every raw point in a requested time range and sends the copied array through `postMessage`. The webview then sorts, merges, de-duplicates, trims, and finally performs pixel-column min/max selection during drawing. A zoom-out can therefore copy and serialize hundreds of thousands or millions of JavaScript objects even though the canvas can display only a few thousand columns. Range coverage is tracked only by time, so a range loaded for one zoom level may also be incorrectly reused at a different resolution.

## Architecture

### 1. Host-side display decimation

Add a pure Timeline decimator that reads a sorted raw point array without first slicing it. It locates the requested interval with binary search, includes at most one predecessor for boundary continuity, and emits time-ordered min/max points per bucket.

The decimator must:

- preserve first/last visible behavior and extrema;
- never aggregate across `startsNewSegment` boundaries;
- carry `startsNewSegment` to the first emitted point of a new segment;
- return raw points when the selected range is already below the output budget;
- keep output proportional to the requested bucket count rather than raw sample count.

`DataSamplingManager` exposes a display-range method, leaving the existing raw-range method available for existing callers and tests.

### 2. Resolution-aware request protocol

Each `loadRange` request includes:

- `requestId` for matching the response;
- `generation` for rejecting responses from an older viewport/cache generation;
- `start` and `end` timestamps;
- `targetBuckets`, derived from the plot width and requested range;
- a quantized `resolutionKey`, representing milliseconds per bucket.

The provider validates all fields, intersects the request with current host history, asks `DataSamplingManager` for display data, and echoes the generation and resolution key in `rangeSamples`.

### 3. Resolution-aware webview cache

Loaded and pending coverage belongs to one resolution generation. When zoom changes the quantized resolution:

- increment the generation;
- cancel pending coverage from the old generation;
- clear old display-range points rather than merging incompatible levels of detail;
- keep receiving live tail points;
- request the current five-screen buffered range at the new resolution;
- ignore late responses whose generation or resolution key no longer matches.

Pan requests at the same resolution reuse coverage and request only missing intervals. The existing two-screen prefetch and half-screen refill thresholds remain unchanged and are clamped to host history boundaries.

### 4. Live tail and range replacement

Changing resolution replaces the previous display cache instead of merging mixed levels of detail. Within one generation, responses add only the missing ranges selected by the coverage controller. Live batches remain a small tail and are appended once per animation frame. When a range response overlaps live points, timestamps are de-duplicated with the newer live sample taking precedence.

The drawing path consumes only the current display cache plus the live tail. Host-side decimation controls transfer size; the existing canvas pixel-column reduction remains a final rendering guard.

### 5. Gap segmentation

The first valid sample after a sampling generation change is marked `startsNewSegment`. A point is also marked when the interval from the previous accepted point exceeds the configured gap threshold. Remote snapshots preserve the marker end to end. Decimation and webview cache replacement retain it, and the existing trace builder starts a new subpath at the marker.

### 6. Webview lifecycle

Register the Timeline provider with `retainContextWhenHidden: true`. Hidden views do not require bulk catch-up messages because sampling history remains in the host; on visibility return, lightweight bounds notification plus the current resolution-aware range request repairs any missing display cache.

## Test-Driven Implementation Order

1. Add pure decimator tests for extrema, ordering, predecessor inclusion, output budget, empty ranges, and segment boundaries. Run them and confirm failure before implementation.
2. Implement the minimum decimator and add `DataSamplingManager.getDataRangeForDisplay`.
3. Add range-controller tests showing that resolution changes invalidate coverage, stale generations are rejected, same-resolution pans reuse coverage, and history boundaries are respected. Confirm failure, then update the controller and protocol types.
4. Add webview cache tests for range replacement, live-tail overlap, and stale-response rejection. Confirm failure, then integrate the cache with `app.tsx`.
5. Add sampling-gap tests and trace-path regression tests, then implement generation/gap markers.
6. Verify provider validation, Timeline webview retention, and bounded message size through focused tests where practical.

## Performance Bounds

For a plot width of `P` pixels and a five-screen buffered request, the host target is approximately `5P` buckets per expression and at most about `10P` min/max points plus a small number of segment/predecessor points. Raw sample count and ten-minute retention length must not determine the webview message size.

No synchronous operation on wheel or pointer movement may scan the ten-minute host history or merge an unbounded webview array. Range checks remain throttled, and React/canvas updates remain limited to animation frames.

## Verification

Automated verification:

```powershell
npx vitest run src/webview/timeline/timeline-decimation.test.ts
npx vitest run src/webview/timeline/timeline-range.test.ts src/webview/timeline/timeline-sample-buffer.test.ts src/webview/timeline/timeline-trace-path.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Manual VS Code Extension Host verification:

1. Start a Timeline session with at least two expressions and let it sample for several minutes.
2. Switch repeatedly between Terminal and Timeline; verify sampling continues and returning is immediate.
3. Zoom rapidly in and out and drag across retained history; verify there are no multi-second stalls or malformed traces.
4. Pause and resume sampling; verify the gap is not connected by a long line.
5. Reach both the oldest retained point and the live right edge; verify two-screen prefetch clamps correctly and half-screen refill does not loop.

## Scope Boundaries

- Do not change the ten-minute retention policy in this implementation.
- Do not migrate host history to typed arrays in this phase; host-side decimation removes the largest UI/IPC bottleneck first, while a compact ring buffer remains a later memory optimization.
- Do not edit generated `dist/` bundles.
- Do not update `docs/bug-fix-log.md` until the user confirms the fix.
- Do not commit the changes.
