// Read-only CMSIS-DAP v2 acceptance. Run with no active Orbit target owner.
// No halt/run/reset, breakpoint claim, RAM write, or Flash operation is issued.
// Usage: node scripts/cmsis-dap/verify-v2-hw.js --serial=507874001033
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function argument(name, fallback) {
  const item = process.argv.slice(2).find(value => value.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : fallback;
}

async function main() {
  const directory = path.resolve(argument('output', path.join('outputs', 'cmsis-dap-v2',
    new Date().toISOString().replace(/[:.]/g, '-'))));
  fs.mkdirSync(directory, { recursive: true });
  const helper = path.resolve(argument('helper', 'out/native/win32-x64/orbit-cmsis-dap-helper.exe'));
  const child = spawn(helper, ['--transport=auto'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORBIT_CMSIS_DAP_TRACE: '1' } });
  const evidence = {
    date: new Date().toISOString(), helper, helperPid: child.pid, owner: 'cmsis-dap',
    scope: 'USB identity, DAP_Info, SWD connect without reset, DP power-up, MEM-AP and target state reads',
    transportWrites: ['DP ABORT/CTRL-STAT and MEM-AP configuration'],
    targetMutations: [], voltage: 'not measured', checks: [], trace: [], stderr: '',
  };
  let nextId = 1;
  const pending = new Map();
  const exited = new Promise(resolve => {
    child.once('error', error => { evidence.exit = { error: String(error) }; resolve(); });
    child.once('exit', (code, signal) => {
    evidence.exit = { code, signal };
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`helper exited: ${code}/${signal}`));
    }
    pending.clear();
    resolve();
    });
  });
  child.on('error', error => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  child.stderr.on('data', data => { evidence.stderr += data.toString(); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    evidence.trace.push({ direction: 'helper->client', line });
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    const item = pending.get(frame.id);
    if (!item) return;
    pending.delete(frame.id);
    clearTimeout(item.timer);
    item.resolve(frame.result);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    const frame = { id, method, params };
    evidence.trace.push({ direction: 'client->helper', frame });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
  const check = (name, ok, result) => {
    evidence.checks.push({ name, ok: !!ok, result });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) throw new Error(`${name}: ${JSON.stringify(result)}`);
  };
  let opened = false;
  let connected = false;
  try {
    const hello = await request('hello', { clientProtocol: 1 });
    check('helper protocol', hello.ok, hello);
    // Deliberately omit VID/PID/product filters to exercise automatic discovery.
    const automatic = await request('enumDevices', { transport: 'auto' });
    check('auto prefers named WinUSB probe', automatic.ok &&
      automatic.data?.devices.some(device => device.transport === 'winusb' &&
        /CMSIS[-_ ]?DAP/i.test(device.product)), automatic);
    const expectedSerial = argument('serial', '');
    const selected = expectedSerial
      ? automatic.data.devices.find(device => device.serial === expectedSerial)
      : automatic.data.devices[0];
    check('selected device identity', selected?.transport === 'winusb', selected);
    // Exercise the real serial selector on composite WinUSB interfaces as well.
    const selector = { transport: 'cmsis-dap-v2', vid: selected.vid,
      pid: selected.pid, serial: selected.serial };
    const filtered = await request('enumDevices', selector);
    check('v2 real serial selector', filtered.ok &&
      filtered.data?.devices.some(device => device.path === selected.path), filtered);
    const open = await request('open', selector);
    opened = open.ok;
    check('open WinUSB v2', open.ok && open.data?.transport === 'winusb', open);
    evidence.device = open.data;
    const info = await request('getInfo');
    check('DAP_Info via bulk endpoints', info.ok && info.data?.effectivePacketSize > 0, info);
    evidence.info = info.data;
    const connect = await request('connect', { port: 'SWD', speedKHz: 1000, resetTarget: false });
    // Even failed initialization can have selected the SWD port; always release it.
    connected = true;
    check('SWD connect without target reset', connect.ok, connect);
    for (const [name, reg] of [['DPIDR', 0], ['CTRL/STAT', 4]]) {
      const read = await request('dpRead', { reg });
      check(`read ${name}`, read.ok && Number.isInteger(read.data?.value), read);
    }
    // MEM-AP access requires the debug/system power-up handshake. These writes
    // configure the debug transport; they do not halt/reset the CPU or write RAM.
    for (const [name, reg, value] of [['clear DP sticky faults', 0, 0x1E],
      ['request DP debug/system power', 4, 0x50000000]]) {
      const result = await request('dpWrite', { reg, value });
      check(name, result.ok, result);
    }
    let powered;
    for (let attempt = 0; attempt < 20; ++attempt) {
      powered = await request('dpRead', { reg: 4 });
      if (!powered.ok || ((powered.data?.value & 0xF0000000) >>> 0) === 0xF0000000) break;
    }
    check('DP power-up acknowledged', powered?.ok &&
      ((powered.data?.value & 0xF0000000) >>> 0) === 0xF0000000, powered);
    const cpuid = await request('readMemory', { address: 0xE000ED00, size: 4 });
    check('read Cortex-M CPUID through MEM-AP', cpuid.ok && cpuid.data?.bytes?.length === 4, cpuid);
    for (const [name, address, size] of [['STM32 Flash', 0x08000000, 512], ['SRAM', 0x20000000, 64]]) {
      const result = await request('readMemory', { address, size });
      check(`read ${name} across protocol packets`, result.ok && result.data?.bytes?.length === size, result);
    }
    const state = await request('getState');
    check('read target state', state.ok, state);
    evidence.targetState = state.targetState;
  } catch (error) {
    evidence.error = String(error);
    process.exitCode = 1;
  } finally {
    try {
      if (connected) {
        const result = await request('disconnect');
        check('disconnect', result.ok, result);
      }
      if (opened) {
        const result = await request('close');
        check('close', result.ok, result);
      }
      if (!evidence.exit) {
        const result = await request('shutdown');
        check('shutdown', result.ok, result);
      }
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await exited;
      clearTimeout(timer);
      check('helper exited cleanly', evidence.exit?.code === 0, evidence.exit);
    } catch (error) {
      evidence.cleanupError = String(error);
      process.exitCode = 1;
      child.kill();
      await exited;
    }
    lines.close();
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(directory, 'helper-stderr.log'), evidence.stderr);
    console.log(`Evidence: ${directory}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
