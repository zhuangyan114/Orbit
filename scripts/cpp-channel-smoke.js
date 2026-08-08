const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

const useMock = process.argv.includes('--mock');
const helperPath = path.resolve(argument('helper', path.join('out', 'native', 'win32-x64', 'orbit-jlink-helper.exe')));
const dllPath = argument('dll', useMock ? path.join('out', 'native', 'win32-x64', 'test', 'JLink_x64.dll') : '');
const device = argument('device', 'STM32F407VG');
const speedKHz = Number(argument('speed', '4000'));
const runHardware = process.argv.includes('--hardware') || useMock;
const loadOnly = process.argv.includes('--load-only');

const child = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

lines.on('line', line => {
  const response = JSON.parse(line);
  const resolve = pending.get(response.id);
  if (resolve) {
    pending.delete(response.id);
    resolve(response.result);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 5000);
    pending.set(id, result => {
      clearTimeout(timer);
      resolve(result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function main() {
  const hello = await request('hello', {
    clientProtocol: 2,
    extensionVersion: 'cpp-channel-smoke',
    requiredCapabilities: ['basicDebug', 'readRegister', 'readMemory', 'writeMemory', 'readMemoryBatch', 'hardwareBreakpoints', 'reset'],
  });
  if (!hello.ok) throw new Error(hello.message);
  console.log(`hello: protocol=${hello.data.protocol}, helper=${hello.data.helperVersion}`);

  if (loadOnly || runHardware) {
    const load = await request('load', { dllPath });
    if (!load.ok) throw new Error(`${load.errorCode}: ${load.message}`);
    console.log(`load: ${load.data.dllPath}, version=${load.data.dllVersion}`);
  }

  if (runHardware) {
    const connect = await request('connect', { dllPath, device, speedKHz, interface: 'SWD' });
    if (!connect.ok) throw new Error(`${connect.errorCode}: ${connect.message}`);
    console.log(`connect: ${connect.data.dllPath}`);

    if (useMock) {
      const initialState = await request('getState');
      if (!initialState.ok || initialState.data.state !== 'Halted') {
        throw new Error(`getState failed: ${JSON.stringify(initialState)}`);
      }

      const written = await request('writeMemory', {
        address: 0x20000020,
        bytesBase64: Buffer.from([0x11, 0x22, 0x33, 0x44]).toString('base64'),
      });
      if (!written.ok || written.data.bytesWritten !== 4) {
        throw new Error(`writeMemory failed: ${JSON.stringify(written)}`);
      }
      const readBack = await request('readMemory', { address: 0x20000020, size: 4 });
      if (!readBack.ok || readBack.data.bytesBase64 !== Buffer.from([0x11, 0x22, 0x33, 0x44]).toString('base64')) {
        throw new Error(`writeMemory readback failed: ${JSON.stringify(readBack)}`);
      }

      const batch = await request('readMemoryBatch', {
        reads: [
          { address: 0x20000020, size: 2 },
          { address: 0x20000022, size: 2 },
        ],
      });
      if (!batch.ok || batch.data.reads.length !== 2
          || batch.data.reads[0].bytesBase64 !== Buffer.from([0x11, 0x22]).toString('base64')
          || batch.data.reads[1].bytesBase64 !== Buffer.from([0x33, 0x44]).toString('base64')) {
        throw new Error(`readMemoryBatch failed: ${JSON.stringify(batch)}`);
      }

      const rttStart = await request('startRtt', { controlBlockAddress: 0x20000100 });
      const rttRead = await request('readRtt', { bufferIndex: 0, size: 16 });
      const rttStop = await request('stopRtt', {});
      if (!rttStart.ok || !rttRead.ok || !rttStop.ok
          || Buffer.from(rttRead.data.bytesBase64, 'base64').toString('utf8') !== 'MEM') {
        throw new Error(`RTT lifecycle failed: ${JSON.stringify({ rttStart, rttRead, rttStop })}`);
      }

      const currentBreakpoint = await request('setBreakpoint', { address: 0x08000100, preferredSlot: 0 });
      if (!currentBreakpoint.ok) throw new Error(`setBreakpoint(current PC): ${currentBreakpoint.message}`);
      const nativeStep = await request('stepOverSourceLine', {
        lineStart: 0x08000100,
        lineEnd: 0x08000104,
        waitTimeoutMs: 100,
        maxInstructionSteps: 4,
        breakpoints: { 0: 0x08000100 },
      });
      if (!nativeStep.ok || nativeStep.data.pcAfter !== 0x08000104 || nativeStep.data.cleanupOk !== true) {
        throw new Error(`stepOverSourceLine breakpoint lifecycle failed: ${JSON.stringify(nativeStep)}`);
      }
      const restored = await request('clearBreakpoint', { id: 0 });
      if (!restored.ok) throw new Error(`restored user breakpoint missing: ${restored.message}`);
      console.log('stepOverSourceLine: user breakpoint restored');

      const twoCallPosition = await request('setBreakpoint', { address: 0x08000500, preferredSlot: 0 });
      if (!twoCallPosition.ok) throw new Error(`two-call stepOver setup: ${twoCallPosition.message}`);
      await request('run');
      const clearTwoCallPosition = await request('clearBreakpoint', { id: twoCallPosition.data.id });
      if (!clearTwoCallPosition.ok) throw new Error(`two-call stepOver cleanup: ${clearTwoCallPosition.message}`);
      const twoCallStep = await request('stepOverSourceLine', {
        lineStart: 0x08000500,
        lineEnd: 0x0800050A,
        waitTimeoutMs: 100,
        maxInstructionSteps: 8,
      });
      if (!twoCallStep.ok
          || twoCallStep.data.pcAfter !== 0x0800050A
          || twoCallStep.data.temporaryBreakpointCount !== 2
          || twoCallStep.data.cleanupOk !== true) {
        throw new Error(`stepOverSourceLine consecutive-call cleanup failed: ${JSON.stringify(twoCallStep)}`);
      }
      for (const [slot, address] of [[0, 0x08000520], [1, 0x08000524]]) {
        const probe = await request('setBreakpoint', { address, preferredSlot: slot });
        if (!probe.ok || probe.data.id !== slot) {
          throw new Error(`stepOverSourceLine left temporary breakpoint in slot ${slot}: ${JSON.stringify(probe)}`);
        }
        const cleared = await request('clearBreakpoint', { id: probe.data.id });
        if (!cleared.ok) throw new Error(`stepOverSourceLine cleanup probe ${slot} failed: ${cleared.message}`);
      }
      console.log('stepOverSourceLine: clears every temporary return breakpoint from consecutive calls');

      const loopLine = await request('setBreakpoint', { address: 0x08000400, preferredSlot: 0 });
      if (!loopLine.ok) throw new Error(`loop stepOver setup: ${loopLine.message}`);
      await request('run');
      const clearLoopLine = await request('clearBreakpoint', { id: loopLine.data.id });
      if (!clearLoopLine.ok) throw new Error(`loop stepOver cleanup: ${clearLoopLine.message}`);
      const loopStep = await request('stepOverSourceLine', {
        lineStart: 0x08000400,
        lineEnd: 0x08000418,
        waitTimeoutMs: 100,
        maxInstructionSteps: 128,
      });
      if (!loopStep.ok || loopStep.data.pcAfter !== 0x08000418 || loopStep.data.instructions !== 48) {
        throw new Error(`stepOverSourceLine loop completion failed: ${JSON.stringify(loopStep)}`);
      }
      const sourceIntoPosition = await request('setBreakpoint', { address: 0x08000104, preferredSlot: 0 });
      if (!sourceIntoPosition.ok) throw new Error(`source stepInto position setup: ${sourceIntoPosition.message}`);
      await request('run');
      const clearSourceIntoPosition = await request('clearBreakpoint', { id: sourceIntoPosition.data.id });
      if (!clearSourceIntoPosition.ok) throw new Error(`source stepInto position cleanup: ${clearSourceIntoPosition.message}`);
      console.log('stepOverSourceLine: completes a four-iteration same-line loop');

      const sourceInto = await request('stepIntoSourceLine', {
        lineStart: 0x08000104,
        lineEnd: 0x0800010C,
        maxInstructionSteps: 8,
      });
      if (!sourceInto.ok
          || sourceInto.data.pcAfter !== 0x08001000
          || sourceInto.data.classification !== 'callEntered'
          || sourceInto.data.instructions !== 3
          || sourceInto.data.trace?.length !== 3) {
        throw new Error(`stepIntoSourceLine call scan failed: ${JSON.stringify(sourceInto)}`);
      }
      console.log('stepIntoSourceLine: two same-line instructions then call entered');

      const ordinaryLine = await request('setBreakpoint', { address: 0x08000300, preferredSlot: 0 });
      if (!ordinaryLine.ok) throw new Error(`ordinary stepInto setup: ${ordinaryLine.message}`);
      await request('run');
      await request('clearBreakpoint', { id: ordinaryLine.data.id });
      const ordinaryInto = await request('stepIntoSourceLine', {
        lineStart: 0x08000300,
        lineEnd: 0x08000304,
        maxInstructionSteps: 8,
      });
      if (!ordinaryInto.ok
          || ordinaryInto.data.pcAfter !== 0x08000304
          || ordinaryInto.data.classification !== 'sourceBoundary') {
        throw new Error(`stepIntoSourceLine ordinary line failed: ${JSON.stringify(ordinaryInto)}`);
      }
      console.log('stepIntoSourceLine: ordinary non-call line reached source boundary');

      const limitedInto = await request('stepIntoSourceLine', {
        lineStart: 0x08000300,
        lineEnd: 0x08000310,
        maxInstructionSteps: 1,
      });
      if (!limitedInto.ok
          || limitedInto.data.pcAfter !== 0x08000306
          || limitedInto.data.classification !== 'instructionLimit'
          || limitedInto.data.instructions !== 1) {
        throw new Error(`stepIntoSourceLine instruction limit failed: ${JSON.stringify(limitedInto)}`);
      }
      console.log('stepIntoSourceLine: same-line scan stops at instruction limit');

      const instructionPosition = await request('setBreakpoint', { address: 0x08000104, preferredSlot: 0 });
      if (!instructionPosition.ok) throw new Error(`stepIntoInstruction position setup: ${instructionPosition.message}`);
      await request('run');
      await request('clearBreakpoint', { id: instructionPosition.data.id });

      const intoBreakpoint = await request('setBreakpoint', { address: 0x08000104, preferredSlot: 0 });
      if (!intoBreakpoint.ok) throw new Error(`stepInto breakpoint setup: ${intoBreakpoint.message}`);
      const nativeInto = await request('stepIntoInstruction');
      if (!nativeInto.ok || nativeInto.data.pcAfter !== 0x08000106) {
        throw new Error(`stepIntoInstruction failed: ${JSON.stringify(nativeInto)}`);
      }
      const intoProbe = await request('setBreakpoint', { address: 0x08000300, preferredSlot: 0 });
      if (!intoProbe.ok || intoProbe.data.id === intoBreakpoint.data.id) {
        throw new Error('stepIntoInstruction unexpectedly cleared the current user breakpoint');
      }
      await request('clearBreakpoint', { id: intoProbe.data.id });
      await request('clearBreakpoint', { id: intoBreakpoint.data.id });
      console.log('stepIntoInstruction: user breakpoint preserved');

      const outBreakpoint = await request('setBreakpoint', { address: 0x08000106, preferredSlot: 0 });
      if (!outBreakpoint.ok) throw new Error(`stepOut breakpoint setup: ${outBreakpoint.message}`);
      const nativeOut = await request('stepOut', {
        functionStart: 0x08000100,
        functionEnd: 0x08000200,
        waitTimeoutMs: 100,
        breakpoints: { [outBreakpoint.data.id]: 0x08000106 },
      });
      if (!nativeOut.ok || nativeOut.data.pcAfter !== 0x08000200 || nativeOut.data.cleanupOk !== true) {
        throw new Error(`stepOut lifecycle failed: ${JSON.stringify(nativeOut)}`);
      }
      const outProbe = await request('setBreakpoint', { address: 0x08000302, preferredSlot: outBreakpoint.data.id });
      if (!outProbe.ok || outProbe.data.id === outBreakpoint.data.id) {
        throw new Error('stepOut did not restore the current user breakpoint');
      }
      await request('clearBreakpoint', { id: outProbe.data.id });
      await request('clearBreakpoint', { id: outBreakpoint.data.id });
      console.log('stepOut: return breakpoint cleaned and user breakpoint restored');

      const clearProbeA = await request('setBreakpoint', { address: 0x08000400, preferredSlot: 0 });
      const clearProbeB = await request('setBreakpoint', { address: 0x08000402, preferredSlot: 1 });
      const clearAll = await request('clearAllBreakpoints');
      const clearReuse = await request('setBreakpoint', { address: 0x08000404, preferredSlot: 0 });
      if (!clearProbeA.ok || !clearProbeB.ok || !clearAll.ok || !clearReuse.ok || clearReuse.data.id !== 0) {
        throw new Error(`clearAllBreakpoints failed: ${JSON.stringify({ clearAll, clearReuse })}`);
      }
      await request('clearBreakpoint', { id: clearReuse.data.id });

      const reset = await request('reset');
      if (!reset.ok || reset.targetState !== 'Halted') {
        throw new Error(`reset failed: ${JSON.stringify(reset)}`);
      }
    }

    for (const [method, params] of [
      ['halt', {}],
      ['readRegister', { index: 15 }],
      ['readMemory', { address: 0x20000000, size: 16 }],
      ['step', {}],
      ['stepIntoInstruction', {}],
      ['stepOverSourceLine', { lineStart: 0, lineEnd: 0, waitTimeoutMs: 100, maxInstructionSteps: 4 }],
      ['run', {}],
    ]) {
      const result = await request(method, params);
      if (!result.ok) throw new Error(`${method}: ${result.errorCode}: ${result.message}`);
      console.log(`${method}: ok (${result.elapsedMs} ms)`);
    }

    const breakpoint = argument('breakpoint', useMock ? '0x08000100' : undefined);
    if (breakpoint !== undefined) {
      const address = Number(breakpoint);
      const set = await request('setBreakpoint', { address });
      if (!set.ok) throw new Error(`setBreakpoint: ${set.errorCode}: ${set.message}`);
      console.log(`setBreakpoint: slot=${set.data.id}`);
      const clear = await request('clearBreakpoint', { id: set.data.id });
      if (!clear.ok) throw new Error(`clearBreakpoint: ${clear.errorCode}: ${clear.message}`);
      console.log('clearBreakpoint: ok');
    }

    if (useMock) {
      await request('writeMemory', {
        address: 0xFFFF0000,
        bytesBase64: Buffer.from([1]).toString('base64'),
      });
      const stateReadError = await request('getState');
      if (stateReadError.ok || stateReadError.errorCode !== 'TargetStateReadFailed') {
        throw new Error(`negative JLINK_IsHalted was not propagated: ${JSON.stringify(stateReadError)}`);
      }
      console.log('getState: negative JLINK_IsHalted propagated as TargetStateReadFailed');
      await request('writeMemory', {
        address: 0xFFFF0000,
        bytesBase64: Buffer.from([0]).toString('base64'),
      });

      await request('writeMemory', {
        address: 0xFFFF0004,
        bytesBase64: Buffer.from([1]).toString('base64'),
      });
      const targetLinkError = await request('getState');
      if (targetLinkError.ok || targetLinkError.errorCode !== 'TargetStateReadFailed'
        || targetLinkError.diagnostics?.function !== 'JLINK_CORESIGHT_ReadAPDPReg') {
        throw new Error(`failed SW-DP health probe was not propagated: ${JSON.stringify(targetLinkError)}`);
      }
      console.log('getState: failed SW-DP health probe propagated as TargetStateReadFailed');
      await request('writeMemory', {
        address: 0xFFFF0004,
        bytesBase64: Buffer.from([0]).toString('base64'),
      });
    }

    const rttControlBlock = argument('rtt-control', undefined);
    if (!useMock && rttControlBlock !== undefined) {
      const controlBlockAddress = Number(rttControlBlock) >>> 0;
      const rttSize = Number(argument('rtt-size', '64'));
      const rttStart = await request('startRtt', { controlBlockAddress });
      const rttRead = await request('readRtt', { bufferIndex: 1, size: rttSize });
      const rttStop = await request('stopRtt', {});
      if (!rttStart.ok || !rttRead.ok || !rttStop.ok || rttRead.elapsedMs > 1000) {
        throw new Error(`hardware RTT lifecycle failed: ${JSON.stringify({ rttStart, rttRead, rttStop })}`);
      }
      console.log(`hardware RTT: start=${rttStart.elapsedMs} ms read=${rttRead.elapsedMs} ms bytes=${Buffer.from(rttRead.data.bytesBase64, 'base64').length}`);
    }
  } else {
    const unknown = await request('notARealMethod');
    if (unknown.ok || unknown.errorCode !== 'ProtocolError') throw new Error('protocol error check failed');
    console.log('protocol: malformed method rejected as expected');
  }

  if (useMock) {
    const disconnected = await request('disconnect');
    if (!disconnected.ok || disconnected.message !== 'disconnected and target resumed') {
      throw new Error(`disconnect did not resume the target: ${JSON.stringify(disconnected)}`);
    }
    console.log('disconnect: target resumed after breakpoint cleanup');
  }

  await request('shutdown');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => {
  if (!child.killed) child.kill();
});
