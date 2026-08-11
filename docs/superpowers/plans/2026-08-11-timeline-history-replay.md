# Timeline History Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore retained Timeline history after webview recreation even when one expression contains about 250,000 samples.

**Architecture:** Keep the existing provider protocol, ten-minute retention, logical DAP sampling clock, and animation-frame batching. Remove the JavaScript argument-limit dependency at both webview append boundaries by replacing variadic `push(...points)` calls with a small stack-safe iterative append helper.

**Tech Stack:** TypeScript, React webview utilities, Vitest, VS Code extension build through esbuild.

## Global Constraints

- Retain ten minutes of effective target-running Timeline history.
- Target Halted time must remain excluded from the active Orbit DAP Timeline clock.
- Do not change sample intervals, send intervals, `samples` message shape, animation-frame batching, trimming, auto-follow, or drawing behavior.
- Do not change target ownership, DAP routing, scheduler priorities, native helper behavior, or generated `dist/` files.
- Preserve all unrelated worktree changes and do not update `docs/bug-fix-log.md` before explicit user confirmation.

---

### Task 1: Stack-Safe Animation-Frame Accumulation

**Files:**
- Modify: `src/webview/timeline/timeline-sample-buffer.test.ts`
- Modify: `src/webview/timeline/timeline-sample-buffer.ts`

**Interfaces:**
- Consumes: `TimelineFrameBatcher.enqueue(snapshots: TimelineSampleSnapshot[]): void`
- Produces: unchanged `TimelineFrameBatcher` behavior that accepts history batches above the JavaScript spread-argument limit.

- [ ] **Step 1: Write the failing large-history frame-batcher test**

Add a shared size constant and this test inside `describe('TimelineFrameBatcher', ...)`:

```typescript
const LARGE_HISTORY_SIZE = 250_000;

it('replays a large retained history without exceeding the JavaScript argument limit', () => {
  let frame: (() => void) | undefined;
  let flushed: TimelineSampleSnapshot[] | undefined;
  const history = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));
  const batcher = new TimelineFrameBatcher(
    callback => { frame = callback; return 1; },
    () => {},
    snapshots => { flushed = snapshots; },
  );

  batcher.enqueue([snapshot(history)]);
  frame?.();

  expect(flushed?.[0].data).toHaveLength(LARGE_HISTORY_SIZE);
  expect(flushed?.[0].data[0]).toEqual(point(0));
  expect(flushed?.[0].data.at(-1)).toEqual(point(LARGE_HISTORY_SIZE - 1));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/webview/timeline/timeline-sample-buffer.test.ts`

Expected: the new test fails from `TimelineFrameBatcher.enqueue` with `RangeError: Maximum call stack size exceeded`; the existing small-batch tests still pass.

- [ ] **Step 3: Add the stack-safe append helper and use it in `TimelineFrameBatcher`**

Add the file-local helper after the scheduler type declarations:

```typescript
function appendItems<T>(target: T[], source: readonly T[]) {
  for (const item of source) target.push(item);
}
```

Replace the frame-batcher spread append with:

```typescript
appendItems(pending.data, snapshot.data);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/webview/timeline/timeline-sample-buffer.test.ts`

Expected: all tests in the file pass, including the 250,000-point frame replay.

- [ ] **Step 5: Commit the first boundary fix**

```powershell
git add -- src/webview/timeline/timeline-sample-buffer.ts src/webview/timeline/timeline-sample-buffer.test.ts
git commit -m "fix: safely batch large timeline histories"
```

### Task 2: Stack-Safe Rendered-History Append

**Files:**
- Modify: `src/webview/timeline/timeline-sample-buffer.test.ts`
- Modify: `src/webview/timeline/timeline-sample-buffer.ts`

**Interfaces:**
- Consumes: `appendTimelineSamples(dataByExpression, snapshots): number | undefined`
- Produces: unchanged return value, in-place array identity, point order, and ten-minute trimming for large snapshots.

- [ ] **Step 1: Write the failing large-history rendered-buffer test**

Add this test inside the existing describe block:

```typescript
it('appends a large retained history in place without exceeding the JavaScript argument limit', () => {
  const existing: ReturnType<typeof point>[] = [];
  const data = new Map([['counter', existing]]);
  const history = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));

  const latestTimestamp = appendTimelineSamples(data, [snapshot(history)]);

  expect(data.get('counter')).toBe(existing);
  expect(existing).toHaveLength(LARGE_HISTORY_SIZE);
  expect(existing[0]).toEqual(point(0));
  expect(existing.at(-1)).toEqual(point(LARGE_HISTORY_SIZE - 1));
  expect(latestTimestamp).toBe(LARGE_HISTORY_SIZE - 1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/webview/timeline/timeline-sample-buffer.test.ts`

Expected: only the new rendered-buffer test fails from `appendTimelineSamples` with `RangeError: Maximum call stack size exceeded`.

- [ ] **Step 3: Use the stack-safe helper in `appendTimelineSamples`**

Replace the rendered-history spread append with:

```typescript
appendItems(existing, snapshot.data);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/webview/timeline/timeline-sample-buffer.test.ts`

Expected: all Timeline sample-buffer tests pass and retain the in-place array identity and ten-minute trim behavior.

- [ ] **Step 5: Commit the second boundary fix**

```powershell
git add -- src/webview/timeline/timeline-sample-buffer.ts src/webview/timeline/timeline-sample-buffer.test.ts
git commit -m "test: cover large timeline history restore"
```

### Task 3: Layered Verification

**Files:**
- Verify only; no generated bundle edits.

**Interfaces:**
- Consumes: completed Timeline sample-buffer changes.
- Produces: fresh unit, type, bundle, full-suite, and diff evidence.

- [ ] **Step 1: Run all focused Timeline tests**

Run: `npx vitest run src/webview/timeline/timeline-sample-buffer.test.ts src/webview/timeline/timeline-trace-path.test.ts`

Expected: both files pass with zero failed tests.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`

Expected: Vitest exits with code 0 and reports zero failed tests.

- [ ] **Step 3: Run static and bundle verification**

Run: `npm run typecheck`

Expected: TypeScript exits with code 0 and emits no diagnostics.

Run: `npm run build`

Expected: esbuild produces all configured bundles and exits with code 0; generated `dist/` output is not manually edited or committed.

- [ ] **Step 4: Inspect the final scoped diff**

Run: `git diff --check HEAD~2..HEAD -- src/webview/timeline/timeline-sample-buffer.ts src/webview/timeline/timeline-sample-buffer.test.ts`

Expected: no whitespace errors. Confirm the implementation diff contains only the stack-safe helper, the two call-site replacements, and the two large-history regression tests.

- [ ] **Step 5: Report the remaining validation gap**

State that automated validation covers the original `RangeError` with a 250,000-point replay, while repeated VS Code Timeline/Terminal switching on a real target remains user acceptance and is not claimed as hardware-passed.
