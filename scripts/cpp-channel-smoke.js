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
  if (!hello.data.capabilities.includes('probeDiscovery')
      || !hello.data.capabilities.includes('rtt')
      || !hello.data.capabilities.includes('rttEnumerate')
      || !hello.data.capabilities.includes('rttWrite')) {
    throw new Error(`hello is missing expected RTT capabilities: ${JSON.stringify(hello.data.capabilities)}`);
  }
  console.log(`hello: protocol=${hello.data.protocol}, helper=${hello.data.helperVersion}`);

  if (loadOnly || runHardware) {
    const load = await request('load', { dllPath });
    if (!load.ok) throw new Error(`${load.errorCode}: ${load.message}`);
    console.log(`load: ${load.data.dllPath}, version=${load.data.dllVersion}`);
  }

  if (runHardware) {
    const probe = await request('probe', { dllPath });
    if (!probe.ok || probe.data.available !== true) {
      throw new Error(`probe discovery failed: ${JSON.stringify(probe)}`);
    }
    console.log(`probe: available, version=${probe.data.dllVersion}`);

    const connect = await request('connect', { dllPath, device, speedKHz, interface: 'SWD' });
    if (!connect.ok) throw new Error(`${connect.errorCode}: ${connect.message}`);
    if (useMock) {
      const caps = connect.data?.rttCapabilities;
      if (!caps || !caps.rttStart?.available || !caps.rttEnumerate?.available
          || !caps.rttUpRead?.available || !caps.rttDownWrite?.available) {
        throw new Error(`connect.data.rttCapabilities incomplete: ${JSON.stringify(connect.data)}`);
      }
      const queriedCaps = await request('getRttCapabilities', {});
      if (!queriedCaps.ok || queriedCaps.data?.ownerKind !== 'jlink-native'
          || !queriedCaps.data?.rttCapabilities?.rttDownWrite?.available) {
        throw new Error(`getRttCapabilities failed: ${JSON.stringify(queriedCaps)}`);
      }
    }
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

      await runRttStage33MockMatrix();
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
  if (useMock) {
    await runMissingEntryJLinkMockMatrix();
  }
}

function u32Bytes(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return [...buf];
}

function i32Bytes(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value | 0, 0);
  return [...buf];
}

function rttHeaderBytes(maxUp, maxDown) {
  const buf = Buffer.alloc(24);
  Buffer.from('SEGGER RTT', 'ascii').copy(buf, 0);
  buf.writeUInt32LE(maxUp >>> 0, 16);
  buf.writeUInt32LE(maxDown >>> 0, 20);
  return [...buf];
}

function rttDescriptorBytes(sName, pBuffer, size, wrOff, rdOff, flags) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(sName >>> 0, 0);
  buf.writeUInt32LE(pBuffer >>> 0, 4);
  buf.writeUInt32LE(size >>> 0, 8);
  buf.writeUInt32LE(wrOff >>> 0, 12);
  buf.writeUInt32LE(rdOff >>> 0, 16);
  buf.writeUInt32LE(flags >>> 0, 20);
  return [...buf];
}

function cstrBytes(text) {
  return [...Buffer.from(`${text}\0`, 'ascii')];
}

function assertMock(condition, message) {
  if (!condition) throw new Error(`Stage 3.3 J-Link mock assertion failed: ${message}`);
}

async function writeMockMemory(address, byteArray) {
  const res = await request('writeMemory', {
    address: address >>> 0,
    bytesBase64: Buffer.from(byteArray).toString('base64'),
  });
  assertMock(res.ok, `writeMemory @0x${address.toString(16)} failed: ${JSON.stringify(res)}`);
}

async function readMockMemory(address, size) {
  const res = await request('readMemory', { address: address >>> 0, size });
  assertMock(res.ok, `readMemory @0x${address.toString(16)} failed: ${JSON.stringify(res)}`);
  return Buffer.from(res.data.bytesBase64, 'base64');
}

async function runRttStage33MockMatrix() {
  const ramRanges = [{ address: 0x24000000, size: 320 * 1024 }];
  const roRanges = [{ address: 0x08000000, size: 1024 * 1024 }];
  const cb = 0x24000100;
  const flashNameAddr = 0x0800F000;
  const nameSysView = 0x24000400;
  const nameEmpty = 0x24000420;
  const nameShell = 0x24000440;
  const up0Buf = 0x24001000;
  const up2Buf = 0x24001100;
  const up3Buf = 0x24001200;
  const down0Buf = 0x24002000; // Mode 0 SKIP, size 8
  const down1Buf = 0x24002100; // Mode 1 TRIM, size 8
  const down2Buf = 0x24002200; // Mode 2 BLOCK, size 8
  const downDesc0 = cb + 24 * 8; // 7 Up + Down[0]
  const downDesc1 = cb + 24 * 9;
  const downDesc2 = cb + 24 * 10;

  await writeMockMemory(flashNameAddr, cstrBytes('FlashCh'));
  await writeMockMemory(nameSysView, cstrBytes('SysView'));
  await writeMockMemory(nameEmpty, [0]);
  await writeMockMemory(nameShell, cstrBytes('Shell'));
  await writeMockMemory(up2Buf, [0x53, 0x56, 0x21]);
  await writeMockMemory(down0Buf, [0x00, 0x00, 0xEE, 0xCC, 0xDD, 0xAA, 0x00, 0x00]);
  await writeMockMemory(down1Buf, new Array(8).fill(0x55));
  await writeMockMemory(down2Buf, new Array(8).fill(0x77));
  await writeMockMemory(cb, [
    ...rttHeaderBytes(7, 3),
    ...rttDescriptorBytes(flashNameAddr, up0Buf, 32, 0, 0, 0),    // Up[0]: RO Flash name
    ...rttDescriptorBytes(0, 0, 0, 0, 0, 0),                      // Up[1]: unused
    ...rttDescriptorBytes(nameSysView, up2Buf, 64, 3, 0, 1),      // Up[2]: SysView (dup 1)
    ...rttDescriptorBytes(nameSysView, up3Buf, 64, 0, 0, 0),      // Up[3]: SysView (dup 2)
    ...rttDescriptorBytes(nameEmpty, up3Buf + 64, 32, 0, 0, 0),   // Up[4]: empty ""
    ...rttDescriptorBytes(0x40020000, 0x24050000, 32, 0, 0, 0),    // Up[5]: corrupt (buffer outside RAM)
    ...rttDescriptorBytes(0x40020000, up3Buf + 128, 32, 0, 0, 0), // Up[6]: invalid-address name
    ...rttDescriptorBytes(nameSysView, down0Buf, 8, 6, 3, 0),     // Down[0]: SysView, Mode 0 SKIP
    ...rttDescriptorBytes(nameShell, down1Buf, 8, 6, 2, 1),       // Down[1]: Shell, Mode 1 TRIM
    ...rttDescriptorBytes(0, down2Buf, 8, 7, 0, 2),               // Down[2]: null name, Mode 2 BLOCK full
  ]);

  // 1. Multi-channel enumerateRtt (direction, index, names, duplicates, unused, corrupt)
  const enumRes = await request('enumerateRtt', {
    controlBlockAddress: cb,
    ramRanges,
    roRanges,
  });
  assertMock(enumRes.ok
    && enumRes.data.maxUpBuffers === 7
    && enumRes.data.maxDownBuffers === 3
    && enumRes.data.validUpCount === 5
    && enumRes.data.validDownCount === 3
    && enumRes.data.unusedCount === 1
    && enumRes.data.corruptCount === 1
    && enumRes.data.duplicateUpNames.join(',') === 'SysView'
    && enumRes.data.duplicateDownNames.length === 0
    && enumRes.data.upBuffers[0].direction === 'up'
    && enumRes.data.upBuffers[0].index === 0
    && enumRes.data.upBuffers[0].name === 'FlashCh'
    && enumRes.data.upBuffers[0].nameStatus === 'ok'
    && enumRes.data.upBuffers[1].status === 'unused'
    && enumRes.data.upBuffers[2].duplicateName === true
    && enumRes.data.upBuffers[3].duplicateName === true
    && enumRes.data.upBuffers[4].nameStatus === 'empty'
    && enumRes.data.upBuffers[5].status === 'corrupt'
    && enumRes.data.upBuffers[5].errorCode === 'RttInvalidBufferLayout'
    && enumRes.data.upBuffers[6].nameStatus === 'invalid-address'
    && enumRes.data.downBuffers[0].direction === 'down'
    && enumRes.data.downBuffers[0].index === 0
    && enumRes.data.downBuffers[0].name === 'SysView'
    && enumRes.data.downBuffers[0].duplicateName === false
    && enumRes.data.downBuffers[1].name === 'Shell'
    && enumRes.data.downBuffers[2].nameStatus === 'null',
  `enumerateRtt mismatch: ${JSON.stringify(enumRes)}`);

  // 2. startRtt + multi-channel readRtt (Up[2] SysView) + omitted CB reuse
  const startRes = await request('startRtt', { controlBlockAddress: cb, ramRanges });
  assertMock(startRes.ok, `startRtt failed: ${JSON.stringify(startRes)}`);
  const reusedEnum = await request('enumerateRtt', { roRanges });
  assertMock(reusedEnum.ok && reusedEnum.data.controlBlockAddress === cb, `enumerateRtt CB reuse failed: ${JSON.stringify(reusedEnum)}`);
  const readSysView = await request('readRtt', { bufferIndex: 2, size: 16 });
  assertMock(readSysView.ok
    && Buffer.from(readSysView.data.bytesBase64, 'base64').toString('hex') === '535621'
    && readSysView.data.bufferIndex === 2
    && readSysView.data.committedRdOff === 3
    && readSysView.data.readBytes === 3
    && readSysView.data.committedBytes === 3,
  `readRtt Up[2] failed: ${JSON.stringify(readSysView)}`);

  // 3. Invalid inputs rejected with DapInvalidRequest / RttInvalidBufferIndex
  for (const [label, badParams] of [
    ['controlBlockAddress=null', { controlBlockAddress: null, ramRanges }],
    ['controlBlockAddress=float', { controlBlockAddress: 603980032.5, ramRanges }],
    ['timeoutMs=null', { controlBlockAddress: cb, ramRanges, timeoutMs: null }],
    ['timeoutMs=10001', { controlBlockAddress: cb, ramRanges, timeoutMs: 10001 }],
  ]) {
    const rej = await request('enumerateRtt', badParams);
    assertMock(!rej.ok && rej.errorCode === 'DapInvalidRequest', `expected DapInvalidRequest for ${label}: ${JSON.stringify(rej)}`);
  }
  const badWriteIndex = await request('writeRtt', {
    controlBlockAddress: cb, ramRanges, bufferIndex: 3, bytesBase64: Buffer.from([1]).toString('base64'),
  });
  assertMock(!badWriteIndex.ok && badWriteIndex.errorCode === 'RttInvalidBufferIndex', `badWriteIndex=${JSON.stringify(badWriteIndex)}`);

  // 4. Down writes: Mode 0 skip, wrapped write, Mode 1 trim short write, Mode 2 WriteTimeout, CB overlap rejection
  const skipWrite = await request('writeRtt', {
    bufferIndex: 0,
    bytesBase64: Buffer.from([1, 2, 3, 4, 5]).toString('base64'),
  });
  assertMock(skipWrite.ok && skipWrite.data.shortWrite === true && skipWrite.data.skipped === true
    && skipWrite.data.committedBytes === 0 && skipWrite.data.committedWrOff === 6
    && skipWrite.data.completion === 'not-started',
  `Mode 0 skip failed: ${JSON.stringify(skipWrite)}`);

  const wrapWrite = await request('writeRtt', {
    bufferIndex: 0,
    bytesBase64: Buffer.from([0x11, 0x22, 0x33, 0x44]).toString('base64'),
  });
  const down0Mem = await readMockMemory(down0Buf, 8);
  const down0DescMem = await readMockMemory(downDesc0, 24);
  assertMock(wrapWrite.ok && wrapWrite.data.wrapped === true && wrapWrite.data.shortWrite === false
    && wrapWrite.data.committedBytes === 4 && wrapWrite.data.committedWrOff === 2
    && wrapWrite.data.rdOff === 3 && wrapWrite.data.wrOffCommitted === true
    && wrapWrite.data.completion === 'completed'
    && down0Mem.equals(Buffer.from([0x33, 0x44, 0xEE, 0xCC, 0xDD, 0xAA, 0x11, 0x22]))
    && down0DescMem.readUInt32LE(12) === 2 && down0DescMem.readUInt32LE(16) === 3,
  `Wrapped writeRtt failed: ${JSON.stringify({ wrapWrite, down0Mem: [...down0Mem] })}`);

  const trimShort = await request('writeRtt', {
    controlBlockAddress: cb,
    ramRanges,
    bufferIndex: 1,
    bytesBase64: Buffer.from([0xA1, 0xA2, 0xA3, 0xA4, 0xA5]).toString('base64'),
  });
  const down1DescMem = await readMockMemory(downDesc1, 24);
  assertMock(trimShort.ok && trimShort.data.shortWrite === true && trimShort.data.skipped === false
    && trimShort.data.wrapped === true && trimShort.data.committedBytes === 3
    && trimShort.data.committedWrOff === 1 && trimShort.data.completion === 'partial'
    && down1DescMem.readUInt32LE(12) === 1 && down1DescMem.readUInt32LE(16) === 2,
  `Mode 1 trim short write failed: ${JSON.stringify(trimShort)}`);

  const blockTimeout = await request('writeRtt', {
    controlBlockAddress: cb,
    ramRanges,
    bufferIndex: 2,
    bytesBase64: Buffer.from([0x5A, 0x5B]).toString('base64'),
    timeoutMs: 10,
  });
  assertMock(!blockTimeout.ok && blockTimeout.errorCode === 'WriteTimeout'
    && blockTimeout.diagnostics?.rtt?.failureStage === 'poll-wait'
    && blockTimeout.diagnostics?.rtt?.completion === 'not-started'
    && blockTimeout.diagnostics?.rtt?.committedBytes === 0,
  `Mode 2 timeout failed: ${JSON.stringify(blockTimeout)}`);

  // Overlapping control block rejected without mutating CB
  const overlapCb = 0x24003000;
  const overlapTable = Buffer.from([
    ...rttHeaderBytes(1, 1),
    ...rttDescriptorBytes(0, 0x24003800, 16, 0, 0, 0),
    ...rttDescriptorBytes(0, overlapCb + 24, 8, 0, 0, 1),
  ]);
  await writeMockMemory(overlapCb, overlapTable);
  const overlapRes = await request('writeRtt', {
    controlBlockAddress: overlapCb,
    ramRanges,
    bufferIndex: 0,
    bytesBase64: Buffer.from([1, 2]).toString('base64'),
  });
  const overlapCbAfter = await readMockMemory(overlapCb, overlapTable.length);
  assertMock(!overlapRes.ok && overlapRes.errorCode === 'RttInvalidBufferLayout'
    && overlapRes.diagnostics?.rtt?.completion === 'not-started'
    && overlapCbAfter.equals(overlapTable),
  `Overlap rejection failed: ${JSON.stringify(overlapRes)}`);

  // 5. Write failure completion states: clean data-first failure, clean commit-wroff failure, partial/unknown commit-wroff
  const failCb = 0x24004000;
  const failDownBuf = 0x24004800;
  const failDownDesc = failCb + 48;
  await writeMockMemory(failCb, [
    ...rttHeaderBytes(1, 1),
    ...rttDescriptorBytes(0, 0x24004400, 16, 0, 0, 0),
    ...rttDescriptorBytes(0, failDownBuf, 8, 6, 3, 1),
  ]);

  // 5a. Clean JLINK_WriteMem=-1 at data-first
  await writeMockMemory(0xFFFF000C, i32Bytes(-1));
  await writeMockMemory(0xFFFF0008, u32Bytes(failDownBuf + 6));
  await writeMockMemory(0xFFFF0014, u32Bytes(1));
  const dataFail = await request('writeRtt', {
    controlBlockAddress: failCb,
    ramRanges,
    bufferIndex: 0,
    bytesBase64: Buffer.from([0x10, 0x20, 0x30, 0x40]).toString('base64'),
  });
  assertMock(!dataFail.ok && dataFail.errorCode === 'RttMemoryWriteFailed'
    && dataFail.diagnostics?.rtt?.failureStage === 'data-first'
    && dataFail.diagnostics?.rtt?.completion === 'not-started'
    && dataFail.diagnostics?.rtt?.committedBytes === 0
    && dataFail.diagnostics?.rtt?.wrOffCommitted === false,
  `data-first clean failure mismatch: ${JSON.stringify(dataFail)}`);

  // 5b. Clean JLINK_WriteMem=-1 at commit-wroff (data written, WrOff NOT committed)
  await writeMockMemory(0xFFFF000C, i32Bytes(-1));
  await writeMockMemory(0xFFFF0008, u32Bytes(failDownDesc + 12));
  await writeMockMemory(0xFFFF0014, u32Bytes(1));
  const wrOffFail = await request('writeRtt', {
    controlBlockAddress: failCb,
    ramRanges,
    bufferIndex: 0,
    bytesBase64: Buffer.from([0x10, 0x20, 0x30, 0x40]).toString('base64'),
  });
  const failDescAfterClean = await readMockMemory(failDownDesc, 24);
  assertMock(!wrOffFail.ok && wrOffFail.errorCode === 'RttMemoryWriteFailed'
    && wrOffFail.diagnostics?.rtt?.failureStage === 'commit-wroff'
    && wrOffFail.diagnostics?.rtt?.writtenBytes === 4
    && wrOffFail.diagnostics?.rtt?.committedBytes === 0
    && wrOffFail.diagnostics?.rtt?.wrOffWriteAttempted === true
    && wrOffFail.diagnostics?.rtt?.wrOffCommitted === false
    && wrOffFail.diagnostics?.rtt?.completion === 'not-started'
    && failDescAfterClean.readUInt32LE(12) === 6,
  `commit-wroff clean failure mismatch: ${JSON.stringify(wrOffFail)}`);

  // 5c. Partial JLINK_WriteMem return (2 of 4 bytes) at commit-wroff -> OutcomeUnknown, completion='unknown', retryable=false
  await writeMockMemory(0xFFFF000C, i32Bytes(2));
  await writeMockMemory(0xFFFF0008, u32Bytes(failDownDesc + 12));
  await writeMockMemory(0xFFFF0014, u32Bytes(1));
  const wrOffUnknown = await request('writeRtt', {
    controlBlockAddress: failCb,
    ramRanges,
    bufferIndex: 0,
    bytesBase64: Buffer.from([0x10, 0x20, 0x30, 0x40]).toString('base64'),
  });
  assertMock(!wrOffUnknown.ok && wrOffUnknown.errorCode === 'OutcomeUnknown'
    && wrOffUnknown.diagnostics?.rtt?.failureStage === 'commit-wroff'
    && wrOffUnknown.diagnostics?.rtt?.writtenBytes === 4
    && wrOffUnknown.diagnostics?.rtt?.committedBytes === 0
    && wrOffUnknown.diagnostics?.rtt?.wrOffWriteAttempted === true
    && wrOffUnknown.diagnostics?.rtt?.wrOffCommitted === false
    && wrOffUnknown.diagnostics?.rtt?.completion === 'unknown'
    && wrOffUnknown.diagnostics?.rtt?.retryable === false,
  `commit-wroff unknown outcome mismatch: ${JSON.stringify(wrOffUnknown)}`);

  await request('stopRtt', {});
  console.log('Stage 3.3 J-Link mock RTT multi-channel & write matrix: passed');
}

async function runMissingEntryJLinkMockMatrix() {
  const noWriteDllPath = path.join('out', 'native', 'win32-x64', 'test', 'JLink_x64_no_write.dll');
  const helper = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const helperLines = readline.createInterface({ input: helper.stdout });
  const helperPending = new Map();
  let reqId = 1;
  helperLines.on('line', line => {
    const response = JSON.parse(line);
    const resolve = helperPending.get(response.id);
    if (resolve) {
      helperPending.delete(response.id);
      resolve(response.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = reqId++;
    const timer = setTimeout(() => {
      helperPending.delete(id);
      reject(new Error(`timeout waiting for missing-entry helper ${method}`));
    }, 5000);
    helperPending.set(id, result => {
      clearTimeout(timer);
      resolve(result);
    });
    helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  try {
    const hello = await call('hello', { clientProtocol: 2, extensionVersion: 'missing-entry-smoke' });
    assertMock(hello.ok, `missing-entry hello failed: ${JSON.stringify(hello)}`);

    const connect = await call('connect', { dllPath: noWriteDllPath, device, speedKHz, interface: 'SWD' });
    assertMock(connect.ok
      && connect.data?.dllApis?.readMem === true
      && connect.data?.dllApis?.writeMem === false
      && connect.data?.dllApis?.rttControl === false
      && connect.data?.dllApis?.rttRead === false
      && connect.data?.rttCapabilities?.rttStart?.available === true
      && connect.data?.rttCapabilities?.rttEnumerate?.available === true
      && connect.data?.rttCapabilities?.rttUpRead?.available === false
      && connect.data?.rttCapabilities?.rttDownWrite?.available === false,
    `missing-entry connect capabilities mismatch: ${JSON.stringify(connect)}`);

    const enumRes = await call('enumerateRtt', { controlBlockAddress: 0x20000100 });
    assertMock(enumRes.ok
      && enumRes.data.validUpCount === 2
      && enumRes.data.validDownCount === 1
      && enumRes.data.upBuffers[0].name === 'Terminal'
      && enumRes.data.upBuffers[1].name === 'SysView'
      && enumRes.data.downBuffers[0].name === 'SysView',
    `missing-entry enumerateRtt failed: ${JSON.stringify(enumRes)}`);

    const startRes = await call('startRtt', { controlBlockAddress: 0x20000100 });
    assertMock(startRes.ok, `missing-entry startRtt failed: ${JSON.stringify(startRes)}`);

    const readRes = await call('readRtt', { bufferIndex: 0, size: 16 });
    assertMock(!readRes.ok && readRes.errorCode === 'UnsupportedCapability',
      `missing-entry readRtt should fail with UnsupportedCapability: ${JSON.stringify(readRes)}`);

    const writeRes = await call('writeRtt', {
      controlBlockAddress: 0x20000100,
      bufferIndex: 0,
      bytesBase64: Buffer.from([1, 2]).toString('base64'),
    });
    assertMock(!writeRes.ok && writeRes.errorCode === 'UnsupportedCapability'
      && writeRes.diagnostics?.rtt?.completion === 'not-started'
      && writeRes.diagnostics?.rtt?.committedBytes === 0,
    `missing-entry writeRtt should fail with UnsupportedCapability: ${JSON.stringify(writeRes)}`);

    const writeMemRes = await call('writeMemory', {
      address: 0x20000000,
      bytesBase64: Buffer.from([1]).toString('base64'),
    });
    assertMock(!writeMemRes.ok && writeMemRes.errorCode === 'UnsupportedCapability',
      `missing-entry writeMemory should fail with UnsupportedCapability: ${JSON.stringify(writeMemRes)}`);

    await call('stopRtt', {});
    await call('shutdown', {});
    console.log('Stage 3.3 J-Link missing optional DLL entry point matrix: passed');
  } finally {
    if (!helper.killed) helper.kill();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => {
  if (!child.killed) child.kill();
});
