'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await delay(50);
  }
  const msg = typeof label === 'function' ? label() : label;
  throw new Error(`Timeout waiting for ${msg} (${timeoutMs}ms)${lastErr ? `: ${lastErr.message}` : ''}`);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseRfc4180Csv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

exports.run = async function run() {
  const reportPath = process.env.ORBIT_RTOS_STAGE53_REPORT;
  const archives = JSON.parse(process.env.ORBIT_RTOS_STAGE53_ARCHIVES || '{}');

  const ext = vscode.extensions.getExtension('orbit-debug.orbit-for-vscode');
  assert.ok(ext, 'orbit-for-vscode extension must be present');
  const api = await ext.activate();
  const provider = api?.rtosProvider;
  const coordinator = api?.traceCoordinator;
  assert.ok(provider && coordinator, 'Test extension mode must expose rtosProvider and traceCoordinator');

  await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => provider.isVisible && provider.readyCount >= 1, 15000, 'RTOS webview ready');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-vs53-'));
  const report = {
    ok: false,
    h723OfflineAndSave: null,
    recoveryOracles: {},
    oracle33SelectionCsv: null,
    millionCsvAndUi: null,
    svdatCapabilityAndGuards: null,
    compatibility51and52: null,
  };

  try {
    // Switch to Trace Timeline and verify UI is ready cleanly without any debug probe attached
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'trace', traceAutoFollow: false } });
    await waitFor(async () => {
      const st = await provider.invokeUiAction('trace.getState').catch(() => null);
      return Boolean(st && typeof st.svdatSupported === 'boolean');
    }, 15000, 'TraceTimelineView mounted');

    // 1. Offline Open H723 real archive copy, Save Archive copy, Reopen Saved copy, Raw .bin Export & Overwrite protection
    console.log('[stage5.3-driver] step 1: H723 offline open, save archive, raw export');
    const h723 = archives.h723Healthy;
    assert.ok(h723 && h723.dir, 'H723 copy prepared');
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: h723.dir });
    const h723OpenRes = provider.lastTraceActionResult;
    assert.equal(h723OpenRes?.ok, true, 'H723 offline archive opens cleanly');
    assert.equal(h723OpenRes?.inspectionStatus, 'completed');
    assert.equal(h723OpenRes?.rawSha256Verified, true);
    const h723RecId = h723OpenRes.recordId;

    const tlH723 = await waitFor(async () => {
      const st = await provider.invokeUiAction('trace.getState').catch(() => null);
      return st && st.recordId === h723RecId && st.lanes?.length >= 2 ? st : null;
    }, 15000, 'TraceTimelineView loaded H723 lanes');
    assert.equal(tlH723.svdatSupported, false, 'Webview must explicitly advertise SVDat unsupported');

    // Save Archive copy via Webview test action -> real Worker saveArchive
    const savedH723Dir = path.join(tmpDir, 'h723-saved-ui');
    const saveTrigger = await provider.invokeUiAction('trace.saveRecording', { targetDir: savedH723Dir });
    assert.equal(saveTrigger.triggered, true, 'trace.saveRecording UI action triggered');
    const saveDone = await waitFor(
      () => (provider.lastTraceActionResult?.action === 'save' && provider.lastTraceActionResult?.targetDir === path.resolve(savedH723Dir)
        ? provider.lastTraceActionResult
        : null),
      15000,
      'UI saveArchive completed',
    );
    assert.equal(saveDone.ok, true);
    assert.equal(saveDone.recoverableRawBytes, h723.rawBytes);
    assert.equal(saveDone.rawSha256Verified, true);

    // Overwrite rejection on non-empty saved archive directory
    await provider.invokeUiAction('trace.saveRecording', { targetDir: savedH723Dir });
    const saveConflict = await waitFor(
      () => (provider.lastTraceActionResult?.action === 'save' && provider.lastTraceActionResult?.ok === false
        ? provider.lastTraceActionResult
        : null),
      10000,
      'Non-empty archive save conflict rejected',
    );
    assert.equal(saveConflict.errorCode, 'RecordingDirectoryNotEmpty');

    // Raw .bin export via Webview action
    const h723RawOut = path.join(tmpDir, 'h723-ui.bin');
    await provider.invokeUiAction('trace.exportRaw', { outputPath: h723RawOut });
    const rawDone = await waitFor(
      () => (provider.lastTraceActionResult?.action === 'exportRaw' && provider.lastTraceActionResult?.outputPath === path.resolve(h723RawOut)
        ? provider.lastTraceActionResult
        : null),
      15000,
      'UI exportRaw completed',
    );
    assert.equal(rawDone.ok, true);
    assert.equal(rawDone.exportedBytes, h723.rawBytes);
    assert.equal(rawDone.sha256, h723.sha256);
    assert.equal(sha256(await fsp.readFile(h723RawOut)), h723.sha256);

    // Viewport CSV export via UI action
    const h723VpCsv = path.join(tmpDir, 'h723-viewport.csv');
    await provider.invokeUiAction('trace.exportCsvViewport', { outputPath: h723VpCsv });
    const vpDone = await waitFor(
      () => (provider.lastTraceActionResult?.action === 'exportCsv' && provider.lastTraceActionResult?.outputPath === path.resolve(h723VpCsv)
        ? provider.lastTraceActionResult
        : null),
      15000,
      'UI H723 viewport CSV export completed',
    );
    assert.equal(vpDone.ok, true);
    assert.ok(vpDone.exportedRows > 0, 'H723 viewport CSV contains rows');
    const h723CsvParsed = parseRfc4180Csv(await fsp.readFile(h723VpCsv, 'utf8'));
    assert.equal(h723CsvParsed.length, vpDone.exportedRows + 1);

    // Compatibility check 5.1 Contexts + 5.2 Events & Terminal on saved archive
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: h723RecId });
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: savedH723Dir });
    const reopenedId = provider.lastTraceActionResult.recordId;
    assert.equal(provider.lastTraceActionResult?.ok, true);
    assert.equal(provider.lastTraceActionResult?.rawSha256Verified, true);
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts' } });
    const ctxState = await waitFor(async () => {
      const st = await provider.invokeUiAction('contexts.getState').catch(() => null);
      return st && st.recordId === reopenedId ? st : null;
    }, 15000, 'Reopened saved archive renders ContextsView');
    const termPrev = provider.terminalPerfSeq;
    await provider.invokeUiAction('contexts.setSubTab', { tab: 'terminal' });
    const termState = await waitFor(async () => {
      if (provider.terminalPerfSeq <= termPrev) return null;
      const st = await provider.invokeUiAction('terminal.getState').catch(() => null);
      return st && st.recordId === reopenedId ? st : null;
    }, 15000, 'Reopened saved archive renders TerminalView');
    report.compatibility51and52 = {
      lanesCount: tlH723.lanes.length,
      contextsMounted: Boolean(ctxState),
      terminalTotalLines: termState.totalLines,
    };
    report.h723OfflineAndSave = {
      recordId: h723RecId,
      rawBytes: h723.rawBytes,
      sha256: h723.sha256,
      savedReopenedShaVerified: true,
      viewportCsvRows: vpDone.exportedRows,
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: reopenedId });
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'trace' } });

    // 2. Recovery oracles in real UI: corrupt-index, corrupt-raw, truncated-final-journal-frame, unsupported-version
    console.log('[stage5.3-driver] step 2: recovery oracles');
    const recCases = [
      { key: 'corruptIndex', info: archives.corruptIndex, expectedDisposition: 'rebuilt-bad-index', expectedBytes: archives.corruptIndex.expectedRawBytes, expectedSha: archives.corruptIndex.expectedSha256 },
      { key: 'corruptRaw', info: archives.corruptRaw, expectedDisposition: 'recovered-prefix-bad-chunk', expectedBytes: archives.corruptRaw.validPrefixBytes, expectedSha: archives.corruptRaw.validPrefixSha256 },
      { key: 'truncatedJournal', info: archives.truncatedJournal, expectedDisposition: 'recovered-interrupted', expectedBytes: archives.truncatedJournal.expectedRawBytes, expectedSha: h723.sha256 },
    ];
    for (const c of recCases) {
      await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: c.info.dir });
      const res = provider.lastTraceActionResult;
      assert.equal(res?.ok, true, `${c.key} must open cleanly as recoverable`);
      assert.equal(res?.recoveryDisposition, c.expectedDisposition, `${c.key} recoveryDisposition`);
      assert.equal(res?.recoverableRawBytes, c.expectedBytes, `${c.key} exact prefix byte count`);

      const outBin = path.join(tmpDir, `${c.key}.bin`);
      await provider.invokeUiAction('trace.exportRaw', { outputPath: outBin });
      const expRes = await waitFor(
        () => (provider.lastTraceActionResult?.action === 'exportRaw' && provider.lastTraceActionResult?.outputPath === path.resolve(outBin)
          ? provider.lastTraceActionResult
          : null),
        10000,
        `${c.key} raw export`,
      );
      assert.equal(expRes.ok, true);
      assert.equal(expRes.exportedBytes, c.expectedBytes);
      assert.equal(expRes.sha256, c.expectedSha);
      report.recoveryOracles[c.key] = {
        status: res.inspectionStatus,
        disposition: res.recoveryDisposition,
        recoverableRawBytes: res.recoverableRawBytes,
        exportedSha256: expRes.sha256,
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: res.recordId });
    }

    // Unsupported formatVersion 999 -> rejected
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: archives.unsupportedVersion.dir });
    const badVerRes = provider.lastTraceActionResult;
    assert.equal(badVerRes?.ok, false, 'formatVersion 999 must be rejected');
    assert.equal(badVerRes?.errorCode, 'UnsupportedArchiveVersion');
    report.recoveryOracles.unsupportedVersion = {
      rejected: true,
      errorCode: badVerRes.errorCode,
    };

    // 3. 33-packet Codex oracle A-B selection Golden CSV in TraceTimelineView
    console.log('[stage5.3-driver] step 3: 33-packet A-B selection CSV');
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'trace', traceTimeUnit: 'absolute-ticks', traceAutoFollow: false } });
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: archives.oracle33.dir });
    const rec33Id = provider.lastTraceActionResult.recordId;
    await waitFor(async () => {
      const st = await provider.invokeUiAction('trace.getState').catch(() => null);
      return st && st.recordId === rec33Id && st.unit === 'absolute-ticks' ? st : null;
    }, 15000, '33-packet archive mounted in absolute-ticks');

    await provider.invokeUiAction('trace.setRange', { startStr: '100', endStr: '300' });
    await provider.invokeUiAction('trace.setCursor', { kind: 'A', timeStr: '140' });
    await provider.invokeUiAction('trace.setCursor', { kind: 'B', timeStr: '180' });
    await waitFor(async () => {
      const st = await provider.invokeUiAction('trace.getState');
      return st.cursorA?.timeStr === '140' && st.cursorB?.timeStr === '180';
    }, 10000, 'A-B cursors placed at [140, 180]');

    const selCsvPath = path.join(tmpDir, 'oracle33-selection.csv');
    const selTrigger = await provider.invokeUiAction('trace.exportCsvSelection', { outputPath: selCsvPath });
    assert.equal(selTrigger.triggered, true, 'trace.exportCsvSelection triggered');
    const selRes = await waitFor(
      () => (provider.lastTraceActionResult?.action === 'exportCsv' && provider.lastTraceActionResult?.outputPath === path.resolve(selCsvPath)
        ? provider.lastTraceActionResult
        : null),
      15000,
      '33-packet A-B selection CSV completed',
    );
    assert.equal(selRes.ok, true);
    assert.equal(selRes.exportSource, 'ab-selection');
    assert.equal(selRes.exportedRows, 15, 'A-B [140, 180) matches exact 15 golden rows');
    const selParsed = parseRfc4180Csv(await fsp.readFile(selCsvPath, 'utf8'));
    assert.equal(selParsed.length, 16);
    assert.equal(selParsed[0][13], 'timeAnchorStatus');
    report.oracle33SelectionCsv = {
      rows: selRes.exportedRows,
      bytes: selRes.exportedBytes,
      sha256: selRes.sha256,
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: rec33Id });

    // 4. Million-event archive Events CSV + .SVDat rejection + Chromium non-blocking check
    console.log('[stage5.3-driver] step 4: 1M Events CSV + SVDat guards');
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts', traceTimeUnit: 'absolute-ticks' } });
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: archives.million.dir });
    const rec1MId = provider.lastTraceActionResult.recordId;
    await waitFor(async () => {
      const st = await provider.invokeUiAction('contexts.getState').catch(() => null);
      return st && st.recordId === rec1MId ? st : null;
    }, 15000, '1M archive mounted');

    await provider.invokeUiAction('contexts.setRangeSource', { source: 'full' });
    const ev1MPrev = provider.eventsPerfSeq;
    await provider.invokeUiAction('contexts.setSubTab', { tab: 'events' });
    await waitFor(async () => {
      if (provider.eventsPerfSeq <= ev1MPrev) return null;
      const st = await provider.invokeUiAction('events.getState').catch(() => null);
      return st && st.recordId === rec1MId && st.domVrows > 0 ? st : null;
    }, 15000, '1M EventsView painted');

    const evIrqPrev = provider.eventsPerfSeq;
    await provider.invokeUiAction('events.setFilter', { category: 'isr', searchText: 'IRQ' });
    const evIrqState = await waitFor(async () => {
      if (provider.eventsPerfSeq <= evIrqPrev) return null;
      const st = await provider.invokeUiAction('events.getState').catch(() => null);
      return st && !st.isStale && st.appliedFilter?.searchText === 'IRQ' && st.totalMatched === 167000 ? st : null;
    }, 20000, '1M EventsView ISR/IRQ filter settled at 167000');

    const irqCsvPath = path.join(tmpDir, 'million-events-irq.csv');
    const evCsvTrig = await provider.invokeUiAction('events.exportCsv', { outputPath: irqCsvPath });
    assert.equal(evCsvTrig.triggered, true, 'events.exportCsv triggered');
    const evCsvDone = await waitFor(
      () => (provider.lastTraceActionResult?.action === 'exportCsv' && provider.lastTraceActionResult?.outputPath === path.resolve(irqCsvPath)
        ? provider.lastTraceActionResult
        : null),
      60000,
      '1M filtered 167000-row Events CSV exported cleanly',
    );
    assert.equal(evCsvDone.ok, true);
    assert.equal(evCsvDone.exportedRows, 167000, '167000 IRQ events streamed cleanly to CSV');
    assert.equal(evIrqState.domVrows <= 120, true, 'Events DOM remained bounded during 1M export');

    // Explicit .SVDat rejections across all UI commands
    await provider.handleMessage({ command: 'traceSaveRecording', recordId: rec1MId, targetDir: path.join(tmpDir, 'nope.SVDat') });
    assert.equal(provider.lastTraceActionResult?.errorCode, 'UnsupportedCapability');
    await provider.handleMessage({ command: 'traceExportRaw', recordId: rec1MId, outputPath: path.join(tmpDir, 'nope.svdat') });
    assert.equal(provider.lastTraceActionResult?.errorCode, 'UnsupportedCapability');
    await provider.handleMessage({
      command: 'traceExportCsv',
      exportSource: 'events-page',
      recordId: rec1MId,
      unit: 'absolute-ticks',
      start: '0',
      end: '100',
      outputPath: path.join(tmpDir, 'nope.SVDat'),
    });
    assert.equal(provider.lastTraceActionResult?.errorCode, 'UnsupportedCapability');

    report.millionCsvAndUi = {
      filteredMatched: evIrqState.totalMatched,
      domVrows: evIrqState.domVrows,
      exportedIrqCsvRows: evCsvDone.exportedRows,
      exportedIrqCsvBytes: evCsvDone.exportedBytes,
      exportedIrqCsvSha256: evCsvDone.sha256,
    };
    report.svdatCapabilityAndGuards = {
      svdatSupported: false,
      saveArchiveRejectedCode: 'UnsupportedCapability',
      exportRawRejectedCode: 'UnsupportedCapability',
      exportCsvRejectedCode: 'UnsupportedCapability',
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: rec1MId });

    report.ok = true;
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};
