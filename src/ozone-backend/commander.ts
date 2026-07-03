import {
  OzoneCommand, OzoneCommandResult,
  DebugSessionConfig, RegisterValue, Variable,
  StackFrame, MemoryBlock, TargetState, WatchValue,
} from './types';
import { flashElf } from './flasher';
import { JLinkDLL } from './jlink-dll';
import { readElfSymbols, SymbolInfo, resolveLineToAddress, preloadLineMappings, preloadAddressMappings, parseDwarfTypeInfo, DwarfInfo, DwarfTypeInfo, DwarfField, OBJDUMP_EXE } from './jlink-symbols';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function daLog(msg: string) {
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'debugadapter.log'), `[${new Date().toISOString()}] DA: ${msg}\n`);
  } catch { }
}

const REG_INDEXES: Record<string, number> = {
  R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5, R6: 6, R7: 7,
  R8: 8, R9: 9, R10: 10, R11: 11, R12: 12,
  SP: 13, LR: 14, PC: 15, xPSR: 16,
};

export class OzoneBackend {
  private jlink: JLinkDLL = new JLinkDLL();
  private state: TargetState = TargetState.Disconnected;
  private symbols: SymbolInfo[] = [];
  private elfPath = '';
  private lineMapCache = new Map<string, Array<{ line: number; address: number }>>();
  private addressLocCache = new Map<number, { file: string; line: number; func: string }>();
  private lineEntries: { address: number; file: string; line: number }[] = [];
  private tempBreakpoint: { index: number; addr: number } | null = null;
  private stepOverClearedBps: { index: number; addr: number }[] = [];
  private _lastTempBpAddr = -1;
  private dwarfInfo: DwarfInfo = { varToType: new Map(), typeDefs: new Map() };

  get currentState(): TargetState {
    return this.state;
  }

  async execute(command: OzoneCommand): Promise<OzoneCommandResult> {
    try {
      switch (command.cmd) {
        case 'connect':
          return await this.doConnect(command.config);
        case 'disconnect':
          return this.doDisconnect();
        case 'halt':
          return this.jlink.halt()
            ? (this.state = TargetState.Halted, { ok: true, data: 'Halted' })
            : { ok: false, error: 'Halt failed' };
        case 'run':
          return this.jlink.run()
            ? (this.state = TargetState.Running, { ok: true, data: 'Running' })
            : { ok: false, error: 'Run failed' };
        case 'stepOver':
          return await this.doStepOver();
        case 'stepInto':
          return await this.doStepInto();
        case 'stepOut':
          return await this.doStepOut();
        case 'reset':
          return this.jlink.reset()
            ? { ok: true, data: 'Reset' }
            : { ok: false, error: 'Reset failed' };
        case 'setBreakpoint':
          return await this.doSetBreakpoint(command.file, command.line, command.condition);
        case 'clearBreakpoint':
          return await this.doClearBreakpoint(command.id);
        case 'clearAllBreakpoints':
          this.jlink.clearAllBreakpoints();
          this.tempBreakpoint = null;
          this.stepOverClearedBps = [];
          return { ok: true, data: 'All breakpoints cleared' };
        case 'getRegisters':
          return await this.doGetRegisters();
        case 'getLocals':
          return await this.doGetLocals();
        case 'getCallStack':
          return await this.doGetCallStack();
        case 'readMemory':
          return await this.doReadMemory(command.address, command.size);
        case 'readRegister':
          return await this.doReadRegister(command.name);
        case 'getTargetState': {
          const halted = this.jlink.isHalted();
          const result = halted ? TargetState.Halted : this.state;
          return { ok: true, data: result };
        }
        case 'flash':
          return await this.doFlash(command.elfPath, command.device, command.interface, command.speedKHz);
case 'readVariableRuntime':
          return await this.readVariableAtRuntime(command.name);
        case 'clearBreakpointAtAddr':
          return this.doClearBreakpointAtAddr(command.addr);
        case 'setBreakpointAtAddr':
          return this.doSetBreakpointAtAddr(command.addr);
        case 'evaluateExpression':
          return await this.doEvaluateExpression(command.expression, command.force);
        case 'loadSymbols':
    if (this.elfPath === command.elfPath && this.symbols.length > 0) {
      return { ok: true, data: `Already loaded ${this.symbols.length} symbols` };
    }
    daLog(`loadSymbols start: ${command.elfPath}`);
    this.elfPath = command.elfPath;
    this.symbols = await readElfSymbols(command.elfPath);
    daLog(`loadSymbols symbols: ${this.symbols.length}`);
    this.lineMapCache = await preloadLineMappings(command.elfPath);
    daLog(`loadSymbols lineMapCache: ${this.lineMapCache.size} files`);
    const funcAddrs = this.symbols
      .filter(s => s.type === 'T' || s.type === 't')
      .map(s => s.address);
    this.addressLocCache = await preloadAddressMappings(command.elfPath, funcAddrs);
    daLog(`loadSymbols addressLocCache: ${this.addressLocCache.size}`);

    const fnameToAbs = new Map<string, string>();
    for (const loc of this.addressLocCache.values()) {
      const base = path.basename(loc.file);
      if (base && !fnameToAbs.has(base)) fnameToAbs.set(base, loc.file);
    }
    for (const [addr, loc] of this.addressLocCache) {
      const base = path.basename(loc.file);
      if (base) fnameToAbs.set(base, loc.file);
    }
    daLog(`loadSymbols fnameToAbs: ${fnameToAbs.size}, entries: ${JSON.stringify([...fnameToAbs].slice(0, 5))}`);

    this.lineEntries = [];
    for (const [fName, entries] of this.lineMapCache) {
      let resolvedFile: string;
      if (path.isAbsolute(fName) && fs.existsSync(fName)) {
        resolvedFile = fName;
      } else if (fnameToAbs.has(fName)) {
        resolvedFile = fnameToAbs.get(fName)!;
      } else {
        const base = path.basename(fName);
        if (fnameToAbs.has(base)) {
          resolvedFile = fnameToAbs.get(base)!;
        } else {
          const elfDir = path.dirname(command.elfPath);
          resolvedFile = path.resolve(elfDir, fName);
        }
      }
      for (const entry of entries) {
        if (entry.address >= 0x08000000 && entry.address < 0x20100000) {
          this.lineEntries.push({ address: entry.address, file: resolvedFile, line: entry.line });
        }
      }
    }
    this.lineEntries.sort((a, b) => a.address - b.address);
    daLog(`loadSymbols lineEntries (filtered): ${this.lineEntries.length}`);
    this.dwarfInfo = await parseDwarfTypeInfo(command.elfPath);
    daLog(`loadSymbols dwarf: ${this.dwarfInfo.varToType.size} vars, ${this.dwarfInfo.typeDefs.size} types`);
    return { ok: true, data: `Loaded ${this.symbols.length} symbols` };
        default:
          return { ok: false, error: `Unsupported command: ${(command as any).cmd}` };
      }
    } catch (err: any) {
      this.state = TargetState.Error;
      return { ok: false, error: err.message ?? String(err) };
    }
  }

  private async doConnect(config: DebugSessionConfig): Promise<OzoneCommandResult> {
    if (this.state === TargetState.Connected) {
      return { ok: true, data: { state: TargetState.Connected } };
    }
    if (!this.jlink.open()) {
      return { ok: false, error: 'Failed to load JLink DLL' };
    }

    const connected = this.jlink.connect(config.device, config.speedKHz);
    if (!connected) {
      this.jlink.close();
      return { ok: false, error: `Failed to connect to ${config.device}` };
    }

    this.jlink.halt();
    this.jlink.clearAllBreakpoints();

    this.state = TargetState.Connected;

    return { ok: true, data: { state: TargetState.Connected } };
  }

  private doDisconnect(): OzoneCommandResult {
    if (this.state === TargetState.Disconnected) {
      return { ok: true, data: null };
    }
    this.jlink.disconnect();
    this.state = TargetState.Disconnected;
    this.symbols = [];
    this.lineMapCache.clear();
    this.addressLocCache.clear();
    this.lineEntries = [];
    return { ok: true, data: null };
  }

  private async doSetBreakpoint(file: string, line: number, condition?: string): Promise<OzoneCommandResult> {
    daLog(`setBreakpoint ${file}:${line} elfPath=${this.elfPath} cacheSize=${this.lineMapCache.size}`);
    const addr = await this.resolveLineAddress(file, line);
    daLog(`setBreakpoint resolved addr=${addr}`);
    if (addr === null) return { ok: false, error: `Cannot resolve ${file}:${line}` };
    console.log(`[Ozone] SetBreakpoint ${file}:${line} → 0x${addr.toString(16).toUpperCase()}`);
    daLog(`setBreakpoint calling jlink.setBreakpoint(${addr.toString(16)})`);
    const bpIndex = this.jlink.setBreakpoint(addr);
    daLog(`setBreakpoint jlink result=${bpIndex}`);
    if (bpIndex === null) return { ok: false, error: `Failed to set breakpoint at 0x${addr.toString(16)}` };
    console.log(`[Ozone] Breakpoint set, index=${bpIndex}`);
    return { ok: true, data: { id: bpIndex, address: addr } };
  }

  private async doClearBreakpoint(id: number): Promise<OzoneCommandResult> {
    daLog(`doClearBreakpoint id=${id}`);
    const result = this.jlink.clearBreakpoint(id);
    daLog(`doClearBreakpoint result=${result}`);
    return result
      ? { ok: true, data: null }
      : { ok: false, error: 'Failed to clear breakpoint' };
  }

  private doClearBreakpointAtAddr(addr: number): OzoneCommandResult {
    const index = this.jlink.clearBreakpointAtAddr(addr);
    if (index !== null) {
      return { ok: true, data: { index } };
    }
    return { ok: false, error: `No breakpoint at 0x${addr.toString(16)}` };
  }

  private doSetBreakpointAtAddr(addr: number): OzoneCommandResult {
    const index = this.jlink.setBreakpoint(addr);
    if (index !== null) {
      return { ok: true, data: { id: index, address: addr } };
    }
    return { ok: false, error: `Failed to set breakpoint at 0x${addr.toString(16)}` };
  }

  private async doGetRegisters(): Promise<OzoneCommandResult> {
    const isHalted = this.jlink.isHalted();
    daLog(`doGetRegisters: isHalted=${isHalted}`);
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    const registers: RegisterValue[] = [];

    for (const [name, idx] of Object.entries(REG_INDEXES)) {
      const val = this.jlink.readRegister(idx);
      if (val !== null) {
        registers.push({
          name,
          value: val,
          hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}`,
        });
      }
    }

    return { ok: true, data: registers };
  }

  private async doReadRegister(name: string): Promise<OzoneCommandResult> {
    if (!this.jlink.isHalted()) {
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'Failed to halt CPU for register read' };
    }
    await new Promise<void>(r => setTimeout(r, 100));
    const idx = REG_INDEXES[name.toUpperCase()];
    if (idx === undefined) return { ok: false, error: `Unknown register: ${name}` };
    const val = this.jlink.readRegister(idx);
    if (val === null) return { ok: false, error: `Failed to read ${name}` };
    return { ok: true, data: { name, value: val, hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}` } };
  }

  private async doGetLocals(): Promise<OzoneCommandResult> {
    const isHalted = this.jlink.isHalted();
    daLog(`doGetLocals: isHalted=${isHalted}`);
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    const variables: Variable[] = [];
    const localSymbols = this.symbols.filter(s =>
      s.type === 'd' || s.type === 'D' || s.type === 'B' || s.type === 'b'
    );

    for (const sym of localSymbols.slice(0, 50)) {
      const readSize = Math.min(Math.max(sym.size || 4, 4), 4);
      const raw = this.jlink.readMemory(sym.address, readSize);
      let value: string;
      if (raw) {
        let v = 0;
        for (let i = raw.length - 1; i >= 0; i--) v = (v << 8) | raw[i];
        if (sym.size <= 1) value = `0x${v.toString(16).toUpperCase()} (${v})`;
        else if (sym.size <= 2) value = `0x${v.toString(16).toUpperCase()} (${v})`;
        else value = `0x${v.toString(16).toUpperCase().padStart(8, '0')}`;
      } else {
        value = `0x${sym.address.toString(16).toUpperCase()}`;
      }
      variables.push({
        name: sym.name,
        type: sym.type,
        value,
        address: sym.address,
      });
    }

    return { ok: true, data: variables };
  }

  private async doGetCallStack(): Promise<OzoneCommandResult> {
    const isHalted = this.jlink.isHalted();
    daLog(`doGetCallStack: isHalted=${isHalted}`);
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    await new Promise<void>(r => setTimeout(r, 100));

    const pc = this.jlink.readRegister(REG_INDEXES.PC);
    const lr = this.jlink.readRegister(REG_INDEXES.LR);
    daLog(`doGetCallStack pc=${pc !== null ? '0x' + pc.toString(16) : 'null'} lr=${lr !== null ? '0x' + lr.toString(16) : 'null'}`);

    if (pc === null || lr === null) {
      daLog('doGetCallStack readReg failed');
      return { ok: false, error: 'Cannot read core registers' };
    }

    const frames: StackFrame[] = [];

    const pcLoc = this.resolveAddressLoc(pc);
    daLog(`doGetCallStack pcLoc=${JSON.stringify(pcLoc)}`);
    frames.push({
      id: 0, level: 0,
      function: pcLoc?.func || this.resolveSymbolName(pc) || `0x${pc.toString(16)}`,
      file: pcLoc?.file || '',
      line: pcLoc?.line || 0,
      address: pc,
    });

    if (lr !== 0xFFFFFFFF) {
      const lrLoc = this.resolveAddressLoc(lr);
      frames.push({
        id: 1, level: 1,
        function: lrLoc?.func || this.resolveSymbolName(lr) || `0x${lr.toString(16)}`,
        file: lrLoc?.file || '',
        line: lrLoc?.line || 0,
        address: lr,
      });
    }

    return { ok: true, data: frames };
  }

  private async ensureHalted(): Promise<boolean> {
    this.jlink.halt();
    const immediate = this.jlink.isHalted();
    daLog(`ensureHalted: immediate=${immediate}`);
    if (immediate) return true;
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setTimeout(r, 50));
      const check = this.jlink.isHalted();
      daLog(`ensureHalted: poll ${i + 1} isHalted=${check}`);
      if (check) return true;
    }
    daLog('ensureHalted: timeout waiting for halt');
    return false;
  }

  private cleanupStepBreakpoints(): void {
    daLog(`cleanupStepBreakpoints: tempBp=${this.tempBreakpoint ? `${this.tempBreakpoint.index}@0x${this.tempBreakpoint.addr.toString(16)}` : 'null'} clearedBps=${this.stepOverClearedBps.length}`);
    if (this.tempBreakpoint) {
      this._lastTempBpAddr = this.tempBreakpoint.addr;
      this.jlink.clearBreakpoint(this.tempBreakpoint.index);
      this.tempBreakpoint = null;
    }
    this.restoreClearedBps();
  }

  private restoreClearedBps(): void {
    if (this.stepOverClearedBps.length > 0) {
      daLog(`restoreClearedBps: restoring ${this.stepOverClearedBps.length} breakpoints`);
    }
    for (const bp of this.stepOverClearedBps) {
      const setOk = this.jlink.setBreakpoint(bp.addr);
      daLog(`restoreClearedBps: addr=0x${bp.addr.toString(16)} origSlot=${bp.index} newSlot=${setOk}`);
    }
    this.stepOverClearedBps = [];
  }

  private clearCurrentBpAndTrack(pc: number): void {
    const slots = this.jlink.breakpointSlots;
    let cleared = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === pc) {
        if (this.jlink.clearBreakpoint(i)) {
          this.stepOverClearedBps.push({ index: i, addr: pc });
          cleared++;
        }
      }
    }
    daLog(`clearCurrentBpAndTrack: pc=0x${pc.toString(16)} cleared=${cleared} tracked=${this.stepOverClearedBps.length}`);
  }

  private async doStepInto(): Promise<OzoneCommandResult> {
    const haltedBefore = await this.ensureHalted();
    daLog(`doStepInto: ensureHalted=${haltedBefore}`);
    if (!haltedBefore) return { ok: false, error: 'Cannot halt CPU for step into' };
    await new Promise<void>(r => setTimeout(r, 20));
    this.cleanupStepBreakpoints();
    const pc = this.jlink.readRegister(REG_INDEXES.PC);
    daLog(`doStepInto: pc=0x${pc !== null ? pc.toString(16) : 'null'}`);
    if (pc === null) return { ok: false, error: 'Cannot read PC' };

    let raw = this.jlink.readMemory(pc, 4);
    if (!raw || raw.length < 4) {
      daLog('doStepInto: readMemory failed, retrying after 10ms');
      await new Promise<void>(r => setTimeout(r, 10));
      raw = this.jlink.readMemory(pc, 4);
    }

    let hw1 = 0, hw2 = 0;
    if (raw && raw.length >= 2) {
      hw1 = (raw[1] << 8) | raw[0];
      if (raw.length >= 4) hw2 = (raw[3] << 8) | raw[2];
    }

    const isBL = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0xD000;
    const isBLX = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x8000;
    const isBLXReg = (hw1 & 0xFF87) === 0x4780;
    daLog(`doStepInto: hw1=0x${hw1.toString(16)} hw2=0x${hw2.toString(16)} isBL=${isBL} isBLX=${isBLX} isBLXReg=${isBLXReg}`);

    this.clearCurrentBpAndTrack(pc);

    if (isBL || isBLX) {
      const S = (hw1 >> 10) & 1;
      const J1 = (hw2 >> 14) & 1;
      const J2 = (hw2 >> 12) & 1;
      const I1 = (~(J1 ^ S)) & 1;
      const I2 = (~(J2 ^ S)) & 1;
      const imm10 = hw1 & 0x3FF;
      const imm11 = hw2 & 0x7FF;
      let imm32 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
      if (imm32 & 0x01000000) imm32 |= 0xFE000000;
      let target = ((pc + 4) + imm32) >>> 0;
      if (isBLX) target = (target & ~3) >>> 0;
      daLog(`doStepInto: BL target=0x${target.toString(16)}`);
      return this.setTempBpAndRun(target);
    }

    if (isBLXReg) {
      const rmIndex = (hw1 >> 3) & 0xF;
      const rmVal = this.jlink.readRegister(rmIndex);
      daLog(`doStepInto: BLX Rm r${rmIndex}=0x${rmVal !== null ? rmVal.toString(16) : 'null'}`);
      if (rmVal === null) {
        daLog('doStepInto: BLX Rm read failed, single step');
        return await this.doSingleStep();
      }
      const target = (rmVal & ~1) >>> 0;
      daLog(`doStepInto: BLX Rm target=0x${target.toString(16)}`);
      return this.setTempBpAndRun(target);
    }

    const startLoc = this.resolveAddressLoc(pc);
    daLog(`doStepInto: not a call instruction, smart step on line ${startLoc?.line} file=${startLoc?.file}`);
    if (startLoc) {
      for (let i = 0; i < 20; i++) {
        const stepResult = await this.doSingleStep();
        if (!stepResult.ok) return stepResult;

        const newPc = this.jlink.readRegister(REG_INDEXES.PC);
        if (newPc === null) return { ok: false, error: 'Cannot read PC after single step' };

        const newLoc = this.resolveAddressLoc(newPc);
        if (!newLoc || newLoc.file !== startLoc.file || newLoc.line !== startLoc.line) {
          daLog(`doStepInto: smart step reached diff line at 0x${newPc.toString(16)}`);
          this.restoreClearedBps();
          return { ok: true, data: 'Stepped' };
        }

        const raw = this.jlink.readMemory(newPc, 4);
        if (!raw || raw.length < 4) continue;

        const hw1 = (raw[1] << 8) | raw[0];
        const hw2 = (raw[3] << 8) | raw[2];

        const isBL = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0xD000;
        const isBLX = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x8000;
        const isBLXReg = (hw1 & 0xFF87) === 0x4780;
        daLog(`doStepInto: smart step ${i + 1} pc=0x${newPc.toString(16)} hw1=0x${hw1.toString(16)} hw2=0x${hw2.toString(16)} isBL=${isBL} isBLX=${isBLX} isBLXReg=${isBLXReg}`);

        if (isBL || isBLX) {
          const S = (hw1 >> 10) & 1;
          const J1 = (hw2 >> 14) & 1;
          const J2 = (hw2 >> 12) & 1;
          const I1 = (~(J1 ^ S)) & 1;
          const I2 = (~(J2 ^ S)) & 1;
          const imm10 = hw1 & 0x3FF;
          const imm11 = hw2 & 0x7FF;
          let imm32 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
          if (imm32 & 0x01000000) imm32 |= 0xFE000000;
          let target = ((newPc + 4) + imm32) >>> 0;
          if (isBLX) target = (target & ~3) >>> 0;
          daLog(`doStepInto: smart step found call target=0x${target.toString(16)}`);
          return this.setTempBpAndRun(target);
        }

        if (isBLXReg) {
          const rmIndex = (hw1 >> 3) & 0xF;
          const rmVal = this.jlink.readRegister(rmIndex);
          if (rmVal === null) continue;
          const target = (rmVal & ~1) >>> 0;
          daLog(`doStepInto: smart step BLX Rm target=0x${target.toString(16)}`);
          return this.setTempBpAndRun(target);
        }
      }
    }
    daLog('doStepInto: smart step exhausted, single step fallback');
    this.restoreClearedBps();
    return await this.doSingleStep();
  }

  private async doStepOut(): Promise<OzoneCommandResult> {
    const haltedBefore = await this.ensureHalted();
    daLog(`doStepOut: ensureHalted=${haltedBefore}`);
    if (!haltedBefore) return { ok: false, error: 'Cannot halt CPU for step out' };
    await new Promise<void>(r => setTimeout(r, 20));
    this.cleanupStepBreakpoints();
    const pc = this.jlink.readRegister(REG_INDEXES.PC);
    const lr = this.jlink.readRegister(REG_INDEXES.LR);
    daLog(`doStepOut: pc=0x${pc !== null ? pc.toString(16) : 'null'} lr=0x${lr !== null ? lr.toString(16) : 'null'}`);
    if (pc === null || lr === null) return { ok: false, error: 'Cannot read PC/LR' };
    if (lr === 0xFFFFFFFF || (lr & 0xF0000000) === 0xF0000000) {
      daLog('doStepOut: LR is not a valid return address, falling back to single step');
      this.clearCurrentBpAndTrack(pc);
      return await this.doSingleStep();
    }
    const returnAddr = (lr & ~1) >>> 0;
    daLog(`doStepOut: setting temp bp at return addr 0x${returnAddr.toString(16)}`);
    this.clearCurrentBpAndTrack(pc);
    const result = await this.setTempBpAndRun(returnAddr);
    if (!this.jlink.isHalted()) {
      daLog('doStepOut: BP did not fire, falling back to single step');
      this.jlink.halt();
      await new Promise<void>(r => setTimeout(r, 100));
      if (this.jlink.isHalted()) {
        return { ok: true, data: 'Stepped' };
      }
      return await this.doSingleStep();
    }
    return result;
  }

  private async doStepOver(): Promise<OzoneCommandResult> {
    const haltedBefore = await this.ensureHalted();
    daLog(`doStepOver: ensureHalted=${haltedBefore}`);
    if (!haltedBefore) return { ok: false, error: 'Cannot halt CPU for step over' };
    await new Promise<void>(r => setTimeout(r, 20));
    this.cleanupStepBreakpoints();
    const pc = this.jlink.readRegister(REG_INDEXES.PC);
    daLog(`doStepOver: pc=0x${pc !== null ? pc.toString(16) : 'null'}`);
    if (pc === null) return { ok: false, error: 'Cannot read PC' };

    let raw = this.jlink.readMemory(pc, 4);
    if (!raw || raw.length < 4) {
      daLog('doStepOver: readMemory failed, retrying after 10ms');
      await new Promise<void>(r => setTimeout(r, 10));
      raw = this.jlink.readMemory(pc, 4);
    }

    let hw1 = 0, hw2 = 0;
    if (raw && raw.length >= 2) {
      hw1 = (raw[1] << 8) | raw[0];
      if (raw.length >= 4) hw2 = (raw[3] << 8) | raw[2];
    }

    const isBL = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0xD000;
    const isBLX = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x8000;
    const isBLXReg = (hw1 & 0xFF87) === 0x4780;
    const instrIs32 = (hw1 >> 11) >= 0x1D;
    daLog(`doStepOver: hw1=0x${hw1.toString(16)} hw2=0x${hw2.toString(16)} isBL=${isBL} isBLX=${isBLX} isBLXReg=${isBLXReg} is32=${instrIs32}`);

    this.clearCurrentBpAndTrack(pc);

    if (isBLXReg) {
      const nextAddr = (pc + 2) >>> 0;
      daLog(`doStepOver: BLX Rm at 0x${pc.toString(16)}, setting temp bp at 0x${nextAddr.toString(16)}`);
      return this.setTempBpAndRun(nextAddr);
    }

    if (isBL || isBLX) {
      const nextAddr = (pc + 4) >>> 0;
      daLog(`doStepOver: ${isBL ? 'BL' : 'BLX'} at 0x${pc.toString(16)}, setting temp bp at 0x${nextAddr.toString(16)}`);
      return this.setTempBpAndRun(nextAddr);
    }
    const startLoc = this.resolveAddressLoc(pc);
    daLog(`doStepOver: find next source line line=${startLoc?.line} file=${startLoc?.file}`);
    if (this.lineEntries.length > 0 && startLoc) {
      let nextAddr: number | null = null;
      for (const entry of this.lineEntries) {
        if (entry.address > pc && entry.file === startLoc.file && entry.line !== startLoc.line) {
          nextAddr = entry.address;
          break;
        }
      }
      if (nextAddr === null) {
        for (const entry of this.lineEntries) {
          if (entry.file === startLoc.file && entry.line !== startLoc.line) {
            nextAddr = entry.address;
            break;
          }
        }
      }
      if (nextAddr !== null) {
        daLog(`doStepOver: next source line at 0x${nextAddr.toString(16)}`);
        return this.setTempBpAndRun(nextAddr);
      }
    }
    daLog('doStepOver: no next source line found, single step');
    return await this.doSingleStep();
  }

  private async doSingleStep(): Promise<OzoneCommandResult> {
    for (let retry = 0; retry < 5; retry++) {
      const stepOk = this.jlink.step();
      daLog(`doSingleStep: retry=${retry} step()=${stepOk}`);
      if (stepOk) {
        this.jlink.halt();
        await new Promise<void>(r => setTimeout(r, 50));
        const haltedNow = this.jlink.isHalted();
        daLog(`doSingleStep: after halt+50ms isHalted=${haltedNow}`);
        this.state = TargetState.Halted;
        return { ok: true, data: 'Stepped' };
      }
      this.jlink.halt();
      await new Promise<void>(r => setTimeout(r, 50));
    }
    return { ok: false, error: 'Step failed after retries' };
  }

  private async waitForHalt(): Promise<boolean> {
    for (let i = 0; i < 500; i++) {
      await new Promise<void>(r => setTimeout(r, 10));
      if (this.jlink.isHalted()) {
        this.state = TargetState.Halted;
        return true;
      }
    }
    daLog('waitForHalt: timeout, one final soft settle');
    this.jlink.halt();
    await new Promise<void>(r => setTimeout(r, 50));
    if (this.jlink.isHalted()) {
      this.state = TargetState.Halted;
      return true;
    }
    return false;
  }

  private async setTempBpAndRun(nextAddr: number): Promise<OzoneCommandResult> {
    const bpIndex = this.jlink.setBreakpoint(nextAddr);
    daLog(`setTempBpAndRun: addr=0x${nextAddr.toString(16)} bpIndex=${bpIndex}`);
    if (bpIndex === null) {
      daLog('setTempBpAndRun: setBreakpoint failed, re-setting cleared bp and using step');
      this.restoreClearedBps();
      return await this.doSingleStep();
    }
    this.tempBreakpoint = { index: bpIndex, addr: nextAddr };

    const curPc = this.jlink.readRegister(REG_INDEXES.PC);
    if (curPc !== null && curPc === this._lastTempBpAddr) {
      const raw = this.jlink.readMemory(curPc, 4);
      let isCall = false;
      if (raw && raw.length >= 4) {
        const hw1 = (raw[1] << 8) | raw[0];
        const hw2 = (raw[3] << 8) | raw[2];
        isCall = ((hw1 & 0xF800) === 0xF000 && ((hw2 & 0xD000) === 0xD000 || (hw2 & 0xD000) === 0x8000))
               || (hw1 & 0xFF87) === 0x4780;
      }
      if (isCall) {
        daLog(`setTempBpAndRun: at stale BP 0x${curPc.toString(16)}, call instr, skipping step`);
      } else {
        daLog(`setTempBpAndRun: at stale BP 0x${curPc.toString(16)}, non-call, single-stepping first`);
        const stepResult = await this.doSingleStep();
        if (!stepResult.ok) return stepResult;
      }
    }

    const runOk = this.jlink.run();
    daLog(`setTempBpAndRun: run=${runOk}`);
    if (!runOk) return { ok: false, error: 'Run failed' };
    this.state = TargetState.Running;
    const halted = await this.waitForHalt();
    daLog(`setTempBpAndRun: waitForHalt=${halted}`);
    if (!halted) {
      this.jlink.halt();
      await new Promise<void>(r => setTimeout(r, 50));
    }
    this.jlink.halt();
    await new Promise<void>(r => setTimeout(r, 50));
    this.cleanupStepBreakpoints();
    return { ok: true, data: 'Stepped' };
  }

  private resolveAddressToLine(address: number): { file: string; line: number } | null {
    if (this.lineEntries.length === 0) return null;
    let lo = 0, hi = this.lineEntries.length - 1;
    if (address < this.lineEntries[0].address) return null;
    if (address >= this.lineEntries[hi].address) {
      if (this.lineEntries[hi].address === address) return this.lineEntries[hi];
      return this.lineEntries[hi];
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineEntries[mid].address <= address) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= 0 && this.lineEntries[lo].address <= address) {
      return this.lineEntries[lo];
    }
    return null;
  }

  private resolveAddressLoc(address: number): { file: string; line: number; func: string } | null {
    const floor = this.resolveAddressToLine(address);
    const cached = this.addressLocCache.get(address);
    const funcName = cached?.func || this.resolveSymbolName(address);

    if (floor) {
      return {
        file: floor.file,
        line: floor.line,
        func: funcName || `0x${address.toString(16)}`,
      };
    }
    if (cached) return cached;

    const symName = this.resolveSymbolName(address);
    if (symName) {
      const sym = this.symbols.find(s => s.name === symName);
      if (sym) {
        const cachedBySym = this.addressLocCache.get(sym.address);
        if (cachedBySym) return cachedBySym;
      }
    }

    return null;
  }

  private async doReadMemory(address: number, size: number): Promise<OzoneCommandResult> {
    const raw = this.jlink.readMemory(address, size);
    this.jlink.halt();
    if (!raw) return { ok: false, error: 'Failed to read memory' };

    const data = Array.from(raw);
    const ascii = data.map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join('');
    const block: MemoryBlock = { address, data, ascii };
    return { ok: true, data: block };
  }

  private async doFlash(elfPath: string, device: string, interface_: string, speedKHz: number): Promise<OzoneCommandResult> {
    const result = await flashElf(elfPath, device, interface_, speedKHz);
    if (result.success) {
      this.elfPath = elfPath;
      this.symbols = await readElfSymbols(elfPath);
      this.lineMapCache = await preloadLineMappings(elfPath);
      const funcAddrs = this.symbols
        .filter(s => s.type === 'T' || s.type === 't')
        .map(s => s.address);
      this.addressLocCache = await preloadAddressMappings(elfPath, funcAddrs);
      this.lineEntries = [];
      const fnameToAbs2 = new Map<string, string>();
      for (const loc of this.addressLocCache.values()) {
        const base = path.basename(loc.file);
        if (base && !fnameToAbs2.has(base)) fnameToAbs2.set(base, loc.file);
      }
      for (const [fName, entries] of this.lineMapCache) {
        let resolvedFile: string;
        if (path.isAbsolute(fName) && fs.existsSync(fName)) {
          resolvedFile = fName;
        } else if (fnameToAbs2.has(fName)) {
          resolvedFile = fnameToAbs2.get(fName)!;
        } else {
          const base = path.basename(fName);
          if (fnameToAbs2.has(base)) {
            resolvedFile = fnameToAbs2.get(base)!;
          } else {
            resolvedFile = path.resolve(path.dirname(elfPath), fName);
          }
        }
        for (const entry of entries) {
          if (entry.address >= 0x08000000 && entry.address < 0x20100000) {
            this.lineEntries.push({ address: entry.address, file: resolvedFile, line: entry.line });
          }
        }
      }
      this.lineEntries.sort((a, b) => a.address - b.address);
      this.dwarfInfo = await parseDwarfTypeInfo(elfPath);
      daLog(`doFlash dwarf: ${this.dwarfInfo.varToType.size} vars, ${this.dwarfInfo.typeDefs.size} types, diag=${this.dwarfInfo._diag || ''}`);
      if (this.dwarfInfo.typeDefs.size === 0) {
        try {
          const out = await new Promise<string>(r => {
            execFile(OBJDUMP_EXE, ['--dwarf=info', elfPath], { maxBuffer: 50 * 1024 * 1024, timeout: 30000, windowsHide: true }, (e, o) => r(o || ''));
          });
          const tagSet = new Set<string>();
          const tagRe = /\(DW_TAG_\w+\)/g;
          let tagM: RegExpExecArray | null;
          while ((tagM = tagRe.exec(out)) !== null) tagSet.add(tagM[0]);
          daLog(`doFlash dwarf tags (${tagSet.size} unique, ${(out.match(/\(DW_TAG_\w+\)/g) || []).length} total): ${[...tagSet].join(', ')}`);
          const lines = out.split('\n').filter(l => l.includes('DW_TAG'));
          const trimmed = lines.slice(0, 60).join(' ||| ');
          daLog(`doFlash dwarf lines (${lines.length}): ${trimmed}`);
        } catch (e: any) {
          daLog(`doFlash dwarf raw error: ${e.message}`);
        }
      }
      return { ok: true, data: result };
    }
    return { ok: false, error: result.message };
  }

  private resolveSymbolName(address: number): string | null {
    let best: SymbolInfo | null = null;
    for (const sym of this.symbols) {
      if (sym.type === 'T' || sym.type === 't') {
        if (address >= sym.address && address < sym.address + Math.max(sym.size, 1)) {
          if (!best || address - sym.address < address - best.address) {
            best = sym;
          }
        }
      }
    }
    return best?.name || null;
  }

  private async resolveLineAddress(file: string, line: number): Promise<number | null> {
    if (!this.elfPath) return null;

    const fileName = file.split(/[/\\]/).pop() || file;
    for (const [fName, entries] of this.lineMapCache) {
      if (fName === fileName || file.includes(fName)) {
        let bestAddress: number | null = null;
        let bestLine = 0;
        for (const entry of entries) {
          if (entry.line <= line && entry.line > bestLine) {
            bestAddress = entry.address;
            bestLine = entry.line;
          }
        }
        if (bestAddress !== null) return bestAddress;
      }
    }
    return null;
  }

  private async doEvaluateExpression(expression: string, force: boolean = false): Promise<OzoneCommandResult> {
    daLog(`doEvaluateExpression: "${expression}" force=${force}`);
    let sym = this.symbols.find(s => s.name === expression);
    if (!sym) {
      sym = this.symbols.find(s => s.name.toLowerCase() === expression.toLowerCase());
    }
    if (!sym) {
      const regIdx = REG_INDEXES[expression.toUpperCase()];
      if (regIdx !== undefined) {
        const val = this.jlink.readRegister(regIdx);
        if (val !== null) {
          return {
            ok: true,
            data: {
              expression, value: val,
              display: val.toString(10),
              hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}`,
            } as WatchValue,
          };
        }
        return { ok: false, error: `Cannot read register ${expression}` };
      }
      return { ok: false, error: `Symbol not found: ${expression}` };
    }

    daLog(`doEvaluateExpression: sym=${sym.name} addr=0x${sym.address.toString(16)}`);

    if (!force && !this.jlink.isHalted()) {
      daLog(`doEvaluateExpression: CPU is running, returning running`);
      return { ok: false, error: 'running' };
    }

    if (!force) {
      await new Promise<void>(r => setTimeout(r, 100));
    }

    const varTypeOffset = this.dwarfInfo.varToType.get(sym.name);
    daLog(`doEvaluateExpression: varTypeOffset for "${sym.name}" = ${varTypeOffset || 'none'}`);
    if (varTypeOffset) {
      const resolvedType = this.resolveDwarfType(varTypeOffset);
      daLog(`doEvaluateExpression: resolvedType kind=${resolvedType?.kind} name=${resolvedType?.name} fields=${resolvedType?.fields?.length || 0}`);
      if (resolvedType && resolvedType.kind === 'struct' && resolvedType.fields && resolvedType.fields.length > 0) {
        const readLen = resolvedType.byteSize || sym.size || 4;
        daLog(`doEvaluateExpression: reading struct memory at 0x${sym.address.toString(16)} len=${readLen}`);
        const raw = this.jlink.readMemory(sym.address, readLen);
        if (raw) {
          daLog(`doEvaluateExpression: raw bytes length=${raw.length}`);
          const children = this.evaluateStructFields(raw, resolvedType.fields, resolvedType.typeDefs || this.dwarfInfo.typeDefs, sym.address);
          daLog(`doEvaluateExpression: struct children count=${children.length}`);
          const summary = `${resolvedType.name} { ${children.map(c => `${c.expression}=${c.display}`).join(', ')} }`;
          return {
            ok: true,
            data: {
              expression,
              value: children[0]?.value ?? 0,
              display: summary,
              hex: '',
              address: sym.address,
              typeName: resolvedType.name,
              children,
            } as WatchValue,
          };
        } else {
          daLog('doEvaluateExpression: raw read returned null, falling back to flat read');
        }
      } else if (resolvedType && resolvedType.kind === 'array') {
        const arrayInfo = this.dwarfInfo.typeDefs.get(varTypeOffset);
        const count = arrayInfo?.arrayCount || 0;
        const elemType = arrayInfo?.typeOffset ? this.resolveDwarfType(arrayInfo.typeOffset) : null;
        const elemSize = elemType?.byteSize || 4;
        const totalBytes = count * elemSize;
        const readLen = Math.max(totalBytes, sym.size || 4);
        daLog(`doEvaluateExpression: reading array memory at 0x${sym.address.toString(16)} count=${count} elemSize=${elemSize} len=${readLen}`);
        const raw = this.jlink.readMemory(sym.address, readLen);
        if (raw) {
          const children: WatchValue[] = [];
          for (let i = 0; i < count; i++) {
            const elemAddr = sym.address + i * elemSize;
            const elemRawOffset = i * elemSize;
            if (elemType?.kind === 'struct' && elemType.fields) {
              const childRaw = raw.slice(elemRawOffset, elemRawOffset + elemSize);
              const structChildren = this.evaluateStructFields(childRaw, elemType.fields, elemType.typeDefs || this.dwarfInfo.typeDefs, elemAddr);
              children.push({
                expression: `[${i}]`,
                value: structChildren[0]?.value ?? 0,
                display: `${elemType.name || 'struct'} { ${structChildren.map(c => `${c.expression}=${c.display}`).join(', ')} }`,
                hex: '',
                address: elemAddr,
                typeName: elemType.name || '',
                children: structChildren,
              });
            } else {
              let value = 0;
              const end = Math.min(elemRawOffset + elemSize, raw.length);
              for (let j = end - 1; j >= elemRawOffset; j--) {
                value = (value << 8) | raw[j];
              }
              children.push({
                expression: `[${i}]`,
                value,
                display: elemSize <= 2 ? `0x${value.toString(16).toUpperCase()} (${value})` : `0x${value.toString(16).toUpperCase().padStart(8, '0')} (${value})`,
                hex: `0x${value.toString(16).toUpperCase().padStart(elemSize * 2, '0')}`,
                address: elemAddr,
                typeName: elemType?.name || '',
              });
            }
          }
          return {
            ok: true,
            data: {
              expression,
              value: children[0]?.value ?? 0,
              display: children.length > 0
                ? `${count} elems [${children.slice(0, 3).map(c => c.display).join(', ')}${children.length > 3 ? ', ...' : ''}]`
                : `${count} elems`,
              hex: '',
              address: sym.address,
              typeName: `${resolvedType.name || ''}[${count}]`,
              children,
            } as WatchValue,
          };
        } else {
          daLog('doEvaluateExpression: array raw read returned null, falling back to flat read');
        }
      } else {
        daLog(`doEvaluateExpression: not a struct (kind=${resolvedType?.kind}), reading as flat value`);
      }
    } else {
      daLog('doEvaluateExpression: no DWARF type info, reading as flat value');
    }

    const readSize = Math.min(Math.max(sym.size || 4, 4), 4);
    const raw = this.jlink.readMemory(sym.address, readSize);

    if (!raw) {
      return { ok: false, error: `read failed at 0x${sym.address.toString(16)}` };
    }

    let value = 0;
    for (let i = raw.length - 1; i >= 0; i--) {
      value = (value << 8) | raw[i];
    }

    let display: string;
    if (sym.size <= 1) display = `0x${value.toString(16).toUpperCase()} (${value})`;
    else if (sym.size <= 2) display = `0x${value.toString(16).toUpperCase()} (${value})`;
    else display = `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;

    let typeName = '';
    if (varTypeOffset) {
      const tn = this.getDwarfTypeName(varTypeOffset);
      if (tn) typeName = tn;
    }

    return {
      ok: true,
      data: {
        expression, value, display,
        hex: `0x${value.toString(16).toUpperCase().padStart(8, '0')}`,
        address: sym.address,
        typeName,
      } as WatchValue,
    };
  }

  private resolveDwarfType(offset: string, visited?: Set<string>): { kind: string; name: string; byteSize: number; fields?: DwarfField[]; typeDefs?: Map<string, DwarfTypeInfo>; typeName?: string; typeOffset?: string; arrayCount?: number } | null {
    if (!visited) visited = new Set();
    if (visited.has(offset)) return null;
    visited.add(offset);
    const info = this.dwarfInfo.typeDefs.get(offset);
    if (!info) return null;
    if (info.kind === 'typedef' && info.typeOffset) {
      const resolved = this.resolveDwarfType(info.typeOffset, visited);
      if (resolved) return { ...resolved, typeName: info.name };
      return { kind: 'typedef', name: info.name, byteSize: 0, typeName: info.name };
    }
    if (info.kind === 'struct') {
      return { kind: 'struct', name: info.name, byteSize: info.byteSize, fields: info.fields, typeDefs: this.dwarfInfo.typeDefs };
    }
    return { kind: info.kind, name: info.name, byteSize: info.byteSize, typeName: info.name, typeOffset: info.typeOffset, arrayCount: info.arrayCount };
  }

  private getDwarfTypeName(offset: string): string {
    const resolved = this.resolveDwarfType(offset);
    return resolved?.typeName || resolved?.name || '';
  }

  private evaluateStructFields(raw: Uint8Array, fields: DwarfField[], typeDefs: Map<string, DwarfTypeInfo>, baseAddress: number): WatchValue[] {
    return fields.map(f => this.evaluateSingleField(raw, f, typeDefs, baseAddress));
  }

  private evaluateSingleField(raw: Uint8Array, field: DwarfField, typeDefs: Map<string, DwarfTypeInfo>, baseAddress: number): WatchValue {
    const addr = baseAddress + field.byteOffset;
    const resolved = this.resolveDwarfType(field.typeOffset);
    const resolvedKind = resolved?.kind || '';
    const resolvedName = resolved?.name || '';
    const resolvedByteSize = resolved?.byteSize || 0;

    if (resolvedKind === 'struct' && resolved?.fields) {
      const childRaw = resolvedByteSize > 0
        ? raw.slice(field.byteOffset, field.byteOffset + resolvedByteSize)
        : raw;
      const children = this.evaluateStructFields(childRaw, resolved.fields, typeDefs, addr);
      const summary = `${resolvedName} { ${children.map(c => `${c.expression}=${c.display}`).join(', ')} }`;
      return {
        expression: field.name,
        value: children[0]?.value ?? 0,
        display: summary,
        hex: '',
        address: addr,
        typeName: resolvedName,
        children,
      };
    }

    if (resolvedKind === 'array') {
      const arrayInfo = this.dwarfInfo.typeDefs.get(field.typeOffset);
      const count = arrayInfo?.arrayCount || 0;
      const elemType = arrayInfo?.typeOffset ? this.resolveDwarfType(arrayInfo.typeOffset) : null;
      const elemSize = elemType?.byteSize || 4;
      const totalBytes = count * elemSize;
      const arrRaw = raw.length >= field.byteOffset + totalBytes
        ? raw.slice(field.byteOffset, field.byteOffset + totalBytes)
        : new Uint8Array(0);

      const children: WatchValue[] = [];
      for (let i = 0; i < count; i++) {
        const elemAddr = addr + i * elemSize;
        const elemRawOffset = i * elemSize;
        if (elemType?.kind === 'struct' && elemType.fields) {
          const childRaw = arrRaw.slice(elemRawOffset, elemRawOffset + elemSize);
          const structChildren = this.evaluateStructFields(childRaw, elemType.fields, elemType.typeDefs || this.dwarfInfo.typeDefs, elemAddr);
          children.push({
            expression: `[${i}]`,
            value: structChildren[0]?.value ?? 0,
            display: `${elemType.name || 'struct'} { ${structChildren.map(c => `${c.expression}=${c.display}`).join(', ')} }`,
            hex: '',
            address: elemAddr,
            typeName: elemType.name || '',
            children: structChildren,
          });
        } else {
          let value = 0;
          const end = Math.min(elemRawOffset + elemSize, arrRaw.length);
          for (let j = end - 1; j >= elemRawOffset; j--) {
            value = (value << 8) | arrRaw[j];
          }
          children.push({
            expression: `[${i}]`,
            value,
            display: elemSize <= 2 ? `0x${value.toString(16).toUpperCase()} (${value})` : `0x${value.toString(16).toUpperCase().padStart(8, '0')} (${value})`,
            hex: `0x${value.toString(16).toUpperCase().padStart(elemSize * 2, '0')}`,
            address: elemAddr,
            typeName: elemType?.name || '',
          });
        }
      }

      return {
        expression: field.name,
        value: children[0]?.value ?? 0,
        display: children.length > 0
          ? `${count} elems [${children.slice(0, 3).map(c => c.display).join(', ')}${children.length > 3 ? ', ...' : ''}]`
          : `${count} elems`,
        hex: '',
        address: addr,
        typeName: `${resolvedName || ''}[${count}]`,
        children,
      };
    }

    const fieldSize = resolvedByteSize || 4;
    let value = 0;
    const end = Math.min(field.byteOffset + fieldSize, raw.length);
    for (let i = end - 1; i >= field.byteOffset; i--) {
      value = (value << 8) | raw[i];
    }

    let display: string;
    if (fieldSize <= 1) display = `0x${value.toString(16).toUpperCase()} (${value})`;
    else if (fieldSize <= 2) display = `0x${value.toString(16).toUpperCase()} (${value})`;
    else display = `0x${value.toString(16).toUpperCase().padStart(8, '0')} (${value})`;

    return {
      expression: field.name,
      value,
      display,
      hex: `0x${value.toString(16).toUpperCase().padStart(fieldSize * 2, '0')}`,
      address: addr,
      typeName: resolvedName,
    };
  }

  async readVariableAtRuntime(variableName: string): Promise<OzoneCommandResult> {
    const wasRunning = !this.jlink.isHalted();
    daLog(`readVariableAtRuntime: "${variableName}" wasRunning=${wasRunning}`);
    if (wasRunning) {
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'halt failed' };
    } else {
      await new Promise<void>(r => setTimeout(r, 100));
    }
    const result = await this.doEvaluateExpression(variableName, false);
    if (wasRunning) {
      this.jlink.run();
    }
    return result;
  }

  dispose() {
    this.jlink.disconnect();
  }
}