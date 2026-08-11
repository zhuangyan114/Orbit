# Timeline Lazy Range Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Timeline reopen quickly by loading only the visible interval plus a 2-screen margin on both sides, refilled at a 0.5-screen threshold, while preserving real-time sampling and ten-minute history access.

**Architecture:** Add pure range, slicing, and merge helpers shared by host and webview code. The host retains all data and answers explicit range requests; the retained webview caches requested intervals, receives live samples while visible, and resynchronizes from host bounds after being hidden.

**Tech Stack:** TypeScript, React, VS Code WebviewView API, Vitest, esbuild.

## Global Constraints

- Preserve the full ten-minute extension-side history and Halted logical-clock behavior.
- Preserve DAP routing, target ownership, sampling cadence, scheduler priorities, and live `samples` messages.
- Prefetch exactly 2 visible widths on both sides, refill when less than 0.5 width remains, and clamp both ranges to current history bounds.
- Do not manually edit `dist/`, touch unrelated dirty files, update the bug-fix log before user confirmation, stage, or commit.

---

### Task 1: Range And Merge Primitives

**Files:**
- Create: `src/webview/timeline/timeline-range.ts`
- Create: `src/webview/timeline/timeline-range.test.ts`
- Modify: `src/webview/timeline/timeline-sample-buffer.ts`
- Modify: `src/webview/timeline/timeline-sample-buffer.test.ts`

**Interfaces:**
- Produces: `calculateBufferedRange(viewStart, viewEnd, historyBounds)` with a `2.0` margin per side and clamped output.
- Produces: `sliceTimelineRange(points, start, end)` using binary search and including one predecessor.
- Produces: overlap-safe `appendTimelineSamples` that preserves sorted timestamp order and removes duplicate timestamps.

- [ ] Write failing Vitest cases for a middle range, oldest/latest clamping, empty/invalid bounds, and one predecessor.
- [ ] Run `npx vitest run src/webview/timeline/timeline-range.test.ts` and confirm failures are caused by missing exports.
- [ ] Implement the minimal pure range and binary-search helpers.
- [ ] Run the focused range tests and confirm they pass.
- [ ] Add failing sample-buffer tests where a range response overlaps already-appended live timestamps.
- [ ] Run `npx vitest run src/webview/timeline/timeline-sample-buffer.test.ts` and confirm duplicate timestamps fail.
- [ ] Replace append-only merging with a linear ordered merge that deduplicates equal timestamps while retaining stack-safe large-batch behavior.
- [ ] Run both focused test files and confirm they pass.

### Task 2: Host Range API And Visibility

**Files:**
- Modify: `src/debug-providers/data-sampling-manager.ts`
- Modify: `src/webview/timeline/timeline-provider.ts`
- Modify: `src/extension.ts`
- Test: `src/webview/timeline/timeline-range.test.ts`

**Interfaces:**
- Produces: `DataSamplingManager.getHistoryBounds()` and `getDataRange(expression, start, end)`.
- Consumes: webview `{ command: 'loadRange', requestId, start, end }`.
- Produces: `{ command: 'rangeSamples', requestId, start, end, snapshots }` and `{ command: 'historyBounds', bounds }`.

- [ ] Add failing pure slicing/bounds cases that cover no data and requests outside retained history.
- [ ] Run the focused tests and confirm expected failures.
- [ ] Add host accessors backed by the pure binary-search slice helper.
- [ ] Change `init` to send bounds without full snapshots and handle `loadRange` responses.
- [ ] Track `WebviewView.visible`; suppress live posts while hidden and publish fresh bounds when visibility returns.
- [ ] Register Timeline with `{ webviewOptions: { retainContextWhenHidden: true } }`.
- [ ] Run focused tests and `npm run typecheck`.

### Task 3: Webview Range Controller And Real-Time Resync

**Files:**
- Modify: `src/webview/timeline/app.tsx`
- Modify: `src/webview/timeline/timeline-range.ts`
- Modify: `src/webview/timeline/timeline-range.test.ts`

**Interfaces:**
- Consumes: `init.historyBounds`, `historyBounds`, `rangeSamples`, and unchanged live `samples`.
- Produces: debounced `loadRange` requests based on `[tEnd - timePerDiv * 8, tEnd]` plus 2-screen margins, refilled at a 0.5-screen threshold.

- [ ] Add failing controller tests for initial request, both-side margin, rapid-view coalescing, stale response handling, and a latest-bound refresh after hidden time.
- [ ] Run the focused tests and confirm the controller API is missing.
- [ ] Implement a small range controller that tracks bounds, coverage, request ids, and the latest desired viewport.
- [ ] Wire init, live samples, zoom, pan, and visibility-restored bounds into the controller without changing drawing or sampling cadence.
- [ ] Reset coverage on clear, expression replacement, or a fresh webview init.
- [ ] Run all focused Timeline tests.

### Task 4: Layered Verification

**Files:**
- Verify only; do not edit generated bundles.

- [ ] Run `npx vitest run src/webview/timeline/timeline-range.test.ts src/webview/timeline/timeline-sample-buffer.test.ts src/webview/timeline/timeline-trace-path.test.ts`.
- [ ] Run `npm test` and confirm zero failed tests.
- [ ] Run `npm run typecheck` and confirm no TypeScript diagnostics.
- [ ] Run `npm run build` and confirm all bundles build.
- [ ] Run `git diff --check` and inspect only the scoped Timeline files plus the uncommitted design/plan documents.
- [ ] Report that repeated Timeline/Terminal switching and physical-target real-time behavior still require user acceptance.
