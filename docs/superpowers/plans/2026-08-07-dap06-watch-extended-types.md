# DAP-06 Watch Extended Types Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with TDD and fresh verification. The user explicitly authorized implementation and CMSIS-DAP hardware control. Do not commit Git, edit `dist/` manually, or update `docs/bug-fix-log.md`.

**Goal:** Extend the shared Watch/DWARF evaluator so CMSIS-DAP Watch can display enum names, exact 64-bit integers, bool text, chars/ bounded strings, and function-pointer symbols without regressing `uint8_t` or the existing DAP variable tree.

**Architecture:** Keep the existing DAP session, `OzoneBackend`, `SessionTargetSelector`, `CmsisDapTargetChannel`, native helper, and `NativeScheduler` route. Extend only the shared DWARF metadata and evaluator result model; string reads and function-symbol lookup remain reads through the selected owner. The DAP Watch result keeps expandable children, evaluate names, and memory references. J-Link shared-code compatibility is covered by mock/unit tests, while this phase's hardware evidence uses the authorized CMSIS-DAP probe.

**Tech Stack:** TypeScript 5.5, Vitest, GNU `arm-none-eabi-objdump/nm/readelf`, STM32F407 C firmware, DAP stdio, CMSIS-DAP HID native helper.

## Global Constraints

- Preserve all existing worktree changes and do not revert unrelated files.
- Do not create a second physical owner, J-Link fallback, OpenOCD, GDB server, or second helper.
- All target access remains serialized by `NativeScheduler` with `control > watch > timeline > background`.
- Runtime `dataSample` must not add a target-state query.
- A backend failure must not be replaced by an old Watch cache value and reported as a fresh success.
- `char`/string classification must exclude `uint8_t`, `int8_t`, `unsigned char`, and `signed char` numeric semantics.
- 64-bit values outside the JavaScript safe integer range must be represented exactly, never as an approximate number.
- Do not edit generated `dist/` or commit Git.
- Hardware operations are authorized for the CMSIS-DAP probe: compile, erase/program/verify, reset, halt, run, step, breakpoints, and one restored RAM scalar write. Do not modify Option Bytes or call function pointers.

---

### Task 1: Add failing DWARF metadata tests

**Files:**
- Create: `src/ozone-backend/jlink-symbols-extended-types.test.ts`
- Modify: `src/ozone-backend/jlink-symbols.ts`

**Interfaces:**
- `DwarfTypeInfo` gains enum enumerators and a `subroutine` kind.
- `parseDwarfTypeInfo()` records `DW_TAG_enumerator` name/value and `DW_TAG_subroutine_type` metadata.

- [ ] **Step 1: Write the failing parser tests**

Create an independent fixture of `objdump --dwarf=info` text and assert that parsing produces:

```typescript
expect(typeDefs.get('0x20')).toMatchObject({
  kind: 'enum',
  enumerators: [
    { name: 'DAP06_IDLE', value: '-1' },
    { name: 'DAP06_RUN', value: '2' },
  ],
});
expect(typeDefs.get('0x30')).toMatchObject({ kind: 'subroutine', name: 'uint32_t (uint32_t)' });
```

Use a test-only parser seam or exported pure helper for the fixture; do not invoke the production `objdump` executable in this unit test.

- [ ] **Step 2: Run the focused parser test and verify RED**

Run:

```text
npx vitest run src/ozone-backend/jlink-symbols-extended-types.test.ts
```

Expected: failure because `enumerators` and `subroutine` metadata are not currently produced.

- [ ] **Step 3: Implement the minimal DWARF metadata extension**

Add a `DwarfEnumerator` interface and optional `enumerators` field. Parse enumeration child DIEs using `DW_AT_name` and `DW_AT_const_value` as normalized signed strings. Add `subroutine` to the type-kind union and store its name, byte size, and return/type metadata needed for pointer classification. Preserve typedef/const/volatile/restrict chains.

- [ ] **Step 4: Run the focused parser test and verify GREEN**

Run the same Vitest command. Expected: all parser tests pass with no warnings.

---

### Task 2: Extend the Watch result contract and scalar formatting

**Files:**
- Modify: `src/ozone-backend/types.ts:55-66`
- Modify: `src/ozone-backend/commander.ts:3440-3509`
- Test: `src/ozone-backend/commander-realtime-variables.test.ts`

**Interfaces:**
- `WatchValue.value` becomes `number | string`; existing safe numeric values remain numbers.
- Add optional exact integer metadata, for example `exactValue?: string` and `numericValueExact?: boolean`, with exact hexadecimal in `hex`.
- `formatScalarValue()` returns the same display/hex shape while decoding 64-bit values through `bigint`.

- [ ] **Step 1: Add failing scalar tests**

Add tests for:

```typescript
expect(formatForTest([0xff, ...])).toMatchObject({ value: 255, display: expect.stringContaining('255') });
expect(formatForTest(uint64MaxBytes)).toMatchObject({
  value: '18446744073709551615',
  exactValue: '18446744073709551615',
  hex: '0xFFFFFFFFFFFFFFFF',
  numericValueExact: false,
});
expect(formatForTest(int64MinPlusOneBytes)).toMatchObject({
  value: '-9223372036854775807',
  display: expect.stringContaining('-9223372036854775807'),
});
expect(formatBool(0).display).toContain('0 (false)');
expect(formatBool(1).display).toContain('1 (true)');
expect(formatChar(0x41).display).toContain("'A'");
```

Keep the expected byte arrays and decimal strings in the test as independent oracle data.

- [ ] **Step 2: Run the focused Commander test and verify RED**

Run:

```text
npx vitest run src/ozone-backend/commander-realtime-variables.test.ts -t "extended scalar|64-bit|enum|bool|char"
```

Expected: failure because current scalar formatting returns only JavaScript numbers and does not render enum/bool/char semantics.

- [ ] **Step 3: Implement minimal scalar formatting**

Implement little-endian `bigint` decoding, signed two's-complement conversion, safe-number detection, enum lookup, boolean text, and escaped character formatting. Use the resolved typedef name and kind to keep `uint8_t` numeric. Update all assignments and consumers affected by `number | string`; Timeline/data-sampling paths must skip or return a structured non-numeric result for string-valued unsafe integers rather than coercing them.

- [ ] **Step 4: Run focused tests and typecheck the affected code**

Run:

```text
npx vitest run src/ozone-backend/commander-realtime-variables.test.ts -t "extended scalar|64-bit|enum|bool|char"
npm run typecheck
```

Expected: focused tests pass and TypeScript reports zero errors.

---

### Task 3: Unify bounded char/string evaluation

**Files:**
- Modify: `src/ozone-backend/commander.ts` in `evaluateCharPointerExpression`, `evaluateSingleField`, and top-level expression evaluation
- Modify: `src/ozone-backend/types.ts` only if string metadata needs an optional field
- Test: `src/ozone-backend/commander-realtime-variables.test.ts`

**Interfaces:**
- A single evaluator helper reads a fixed maximum byte range through `evaluateReadMemory()` and returns text plus bounded/truncated metadata.
- `char[N]` uses the array bound; `char*` uses a maximum of 256 bytes and stops at NUL.

- [ ] **Step 1: Add failing string and uint8 regression tests**

Assert independently that:

```typescript
expect(evaluate('charArray')).toMatchObject({ display: '"Orbit-DAP06"' });
expect(evaluate('utf8Array')).toMatchObject({ display: '"轨道调试"' });
expect(evaluate('unterminated')).toMatchObject({ error: expect.stringContaining('unterminated') });
expect(evaluate('nullCharPointer')).toMatchObject({ display: 'NULL' });
expect(evaluate('u8Array').children?.map(child => child.value)).toEqual([0, 127, 128, 255]);
```

Use an in-memory target-read fake that records requested address/size and returns an explicit unreadable-address error; do not use a production helper as the oracle.

- [ ] **Step 2: Run the focused string tests and verify RED**

Run:

```text
npx vitest run src/ozone-backend/commander-realtime-variables.test.ts -t "string|char|uint8"
```

Expected: string/UTF-8/bounded-error assertions fail while numeric `uint8_t` regression remains the baseline.

- [ ] **Step 3: Implement bounded decoding**

Replace the fixed ASCII-dot conversion with bounded UTF-8 decoding and explicit invalid/truncated states. Route direct char pointers, char array fields, and pointer fields through the same helper. Preserve children, `evaluateName`, address, and `memoryReference`. Never classify `uint8_t` or `unsigned char` as strings.

- [ ] **Step 4: Run focused string tests and typecheck**

Run the same Vitest command and `npm run typecheck`. Expected: all pass.

---

### Task 4: Resolve function-pointer symbols

**Files:**
- Modify: `src/ozone-backend/jlink-symbols.ts` if subroutine metadata needs a stable name
- Modify: `src/ozone-backend/commander.ts` in pointer formatting and symbol lookup
- Test: `src/ozone-backend/commander-realtime-variables.test.ts`

**Interfaces:**
- A function pointer is identified by a pointer whose pointee resolves to `subroutine` through typedef/qualifier wrappers.
- Symbol lookup normalizes Thumb bit0 only for lookup and preserves the raw pointer address in the result.

- [ ] **Step 1: Add failing function-pointer tests**

Test exact symbol lookup, Thumb bit normalization, NULL, and unknown addresses:

```typescript
expect(evaluate('g_dap06_function').display).toContain('dap06_transform');
expect(evaluate('g_dap06_function').hex).toBe('0x08001235');
expect(evaluate('nullFunction').display).toBe('NULL');
expect(evaluate('unknownFunction').display).toContain('<unknown>');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```text
npx vitest run src/ozone-backend/commander-realtime-variables.test.ts -t "function pointer"
```

Expected: current pointer formatting shows only an address.

- [ ] **Step 3: Implement symbol-only resolution**

Add a function-symbol lookup over the loaded ELF symbols, require a function symbol type, clear bit0 for matching, and render the function name. Do not use nearest-symbol matching and do not execute the pointer.

- [ ] **Step 4: Run focused tests and typecheck**

Run the focused function-pointer test and `npm run typecheck`. Expected: pass.

---

### Task 5: Fix Watch stale-cache error publication and add DAP contract tests

**Files:**
- Modify: `src/debug/dap-session.ts:558-668`
- Test: `src/debug/dap-session-realtime-variables.test.ts`

**Interfaces:**
- Runtime Watch returns the backend's structured error for a failed current read. Cached values may be used only for explicitly deferred/terminating reads, not to disguise a completed backend failure.

- [ ] **Step 1: Add a failing cache-mask regression test**

Prime a runtime cache with value `1`, make the next forced backend read return `{ ok: false, error: 'DeviceRemoved' }`, and assert the response contains the structured error rather than value `1`. Also assert no fallback backend call occurs.

- [ ] **Step 2: Run the focused DAP test and verify RED**

Run:

```text
npx vitest run src/debug/dap-session-realtime-variables.test.ts -t "does not mask|structured error|cache"
```

Expected: failure because the current branch uses `runtimeWatchCache.get(expr) || errorValue`.

- [ ] **Step 3: Implement the minimal branch change**

Return the structured error for a completed current backend failure, preserve cached/running behavior for generation changes, terminating state, and deferred target reads, and leave `runtimeWatchReadInFlight` cleanup unchanged.

- [ ] **Step 4: Run focused DAP/session tests**

Run:

```text
npx vitest run src/debug/dap-session-realtime-variables.test.ts src/debug/dap-session-scopes.test.ts src/ozone-backend/native-scheduler.test.ts src/utils/watch-expression-validation.test.ts
```

Expected: all pass.

---

### Task 6: Extend the external STM32 fixture and create independent DAPLink evidence

**Files:**
- Modify externally: `D:\STM32\project\vet6_led\Core\Src\freertos.c`
- Create: `scripts/cmsis-dap/verify-dap06-watch-types-hw.js`
- Create at runtime only: `outputs/dap06/watch-types/<timestamp>/evidence.json`

**Interfaces:**
- The fixture exports real ELF/DWARF symbols for enum, int64/uint64, bool, char/UTF-8 strings, bounded non-terminated data, `uint8_t` regression, and a Thumb function pointer.
- The script launches `dist/debugadapter.js` with `probe: cmsis-dap`, HID, VID `C251`, PID `F001`, serial `LU_2022_8888`, and `flashBeforeDebug: true` under the user's authorization.

- [ ] **Step 1: Add the fixture symbols and compile only**

Add initialized volatile globals and a real named transform function, keep them referenced from the task loop, build the external ELF, and verify every requested symbol/type exists using `nm` and `readelf` before connecting hardware.

- [ ] **Step 2: Add script checks before hardware execution**

The script must refuse to run without `--hardware`, refuse pre-existing helper/J-Link/OpenOCD/GDB owners, refuse missing ELF/DWARF symbols, and never issue a function call through the pointer. It must sample without stopped-state prewarm, collect exact display strings, count structured errors, and record owner/helper/DPIDR/flash evidence.

- [ ] **Step 3: Run the authorized CMSIS-DAP hardware acceptance**

Run only after all automation passes:

```text
node scripts/cmsis-dap/verify-dap06-watch-types-hw.js --hardware --duration-ms=60000
```

The script must verify 60-second runtime sampling, enum transitions, bool transitions, exact 64-bit boundaries, ASCII/UTF-8/empty/long/unterminated strings, NULL/unreadable pointer errors, `uint8_t` numeric children, function-symbol resolution, Halt/Step/Continue recovery, one RAM write/restore, helper exit, no stale post-disconnect results, and `jlinkInvolved=false`.

- [ ] **Step 4: Preserve independent evidence**

Never overwrite existing `watch`, `watch-complex`, or `startup-stop` evidence. A failed run remains in its timestamped directory and is reported separately from later successes.

---

### Task 7: Complete verification and report

**Files:**
- Verify only; no `dist/` manual edits and no Git commit.

- [ ] **Step 1: Run focused tests after hardware**

Run all focused commands from Tasks 1-5 and confirm zero failures.

- [ ] **Step 2: Run the full required command sequence**

Run and record real exit codes in order:

```text
npm run typecheck
npm test
npm run build
npm run build:native
npm run test:cmsis-dap:mock
npm run test:cpp-channel:mock
npm run test:cmsis-dap:algorithm
out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest
git diff --check
git status --short -- dist
```

- [ ] **Step 3: Review changed files and evidence**

Confirm all edits are limited to the guide, planned source/tests/script/fixture files, and timestamped evidence; confirm user changes remain present and `dist/` is clean.

- [ ] **Step 4: Report and stop**

Report conclusion, phase, modified files, CMSIS-DAP owner/route, automation exit codes, hardware exact values/statistics, errors/session fence/owner loss, unimplemented scope, operations executed/not executed, and real residual risks. Do not enter DAP-07.
