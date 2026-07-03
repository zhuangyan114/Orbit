import * as koffi from 'koffi';
import * as path from 'path';
import * as fs from 'fs';

const REG_INDEXES: Record<string, number> = {
  R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5, R6: 6, R7: 7,
  R8: 8, R9: 9, R10: 10, R11: 11, R12: 12,
  SP: 13, LR: 14, PC: 15, xPSR: 16,
};

export class JLinkDLL {
  private lib: koffi.LibraryHandle | null = null;
  private _state: 'disconnected' | 'connected' | 'running' | 'halted' | 'error' = 'disconnected';
  private _device = '';
  private _wasOpened = false;
  private bpSlots: (number | null)[] = [null, null, null, null, null, null];

  get connected() { return this._state !== 'disconnected'; }
  get state() { return this._state; }
  get device() { return this._device; }
  get breakpointSlots(): readonly (number | null)[] { return this.bpSlots; }

  private getDllPath(): string {
    try {
      const vscode = require('vscode') as typeof import('vscode');
      const config = vscode.workspace.getConfiguration('ozone');
      const configured = config.get<string>('jlinkDllPath', '');
      if (configured && fs.existsSync(configured)) return configured;
    } catch { }

    const base = 'C:\\Program Files\\SEGGER';
    if (!fs.existsSync(base)) return 'JLink_x64.dll';
    try {
      const dirs = fs.readdirSync(base).filter(d => d.startsWith('JLink_V')).sort().reverse();
      for (const dir of dirs) {
        const p = path.join(base, dir, 'JLink_x64.dll');
        if (fs.existsSync(p)) return p;
      }
    } catch { }

    const p = 'C:\\Program Files\\SEGGER\\Ozone\\JLink_x64.dll';
    return fs.existsSync(p) ? p : 'JLink_x64.dll';
  }

  open(): boolean {
    if (this.lib) return true;
    try {
      const dllPath = this.getDllPath();
      console.log('[JLinkDLL] Loading:', dllPath);
      this.lib = koffi.load(dllPath);
      const ver = this.lib.func('int JLINK_GetDLLVersion(void)')();
      console.log(`[JLinkDLL] v${(ver >>> 8) & 0xFF}.${ver & 0xFF}`);
      return true;
    } catch (err) {
      console.error('[JLinkDLL] Open failed:', err);
      return false;
    }
  }

  close(): void {
    if (!this.lib) return;
    try { this.lib.func('int JLINK_Close(void)')(); } catch { }
    this.lib = null;
    this._state = 'disconnected';
    this._wasOpened = false;
    this.bpSlots = [null, null, null, null, null, null];
  }

  connect(device: string, speedKHz: number): boolean {
    if (!this.lib) return false;
    try {
      if (!this._wasOpened) {
        console.log('[JLinkDLL] JLINK_Open...');
        if (this.lib.func('int JLINK_Open(void)')() < 0) {
          console.log('[JLinkDLL] JLINK_Open FAILED');
          this.lib = null;
          return false;
        }
        this._wasOpened = true;
        console.log('[JLinkDLL] JLINK_Open OK');
      }
      console.log('[JLinkDLL] device', device);
      if (this.lib.func('int JLINK_ExecCommand(const char*)')(`device ${device}`) < 0) {
        console.log('[JLinkDLL] device FAILED');
        this.close();
        return false;
      }
      console.log('[JLinkDLL] device OK');
      console.log('[JLinkDLL] SetSpeed', speedKHz);
      if (this.lib.func('int JLINK_SetSpeed(int)')(speedKHz) < 0) {
        console.log('[JLinkDLL] SetSpeed FAILED');
        this.close();
        return false;
      }
      console.log('[JLinkDLL] SetSpeed OK');
      console.log('[JLinkDLL] TIF_Select SWD');
      if (this.lib.func('int JLINK_TIF_Select(int)')(1) < 0) {
        console.log('[JLinkDLL] TIF_Select FAILED');
        this.close();
        return false;
      }
      console.log('[JLinkDLL] TIF_Select OK');
      console.log('[JLinkDLL] JLINK_Connect...');
      if (this.lib.func('int JLINK_Connect(const char*)')('') < 0) {
        console.log('[JLinkDLL] JLINK_Connect FAILED');
        this.close();
        return false;
      }
      console.log('[JLinkDLL] JLINK_Connect OK');
      this._state = 'connected';
      this._device = device;
      return true;
    } catch (err) {
      console.error('[JLinkDLL] Connect error:', err);
      this.close();
      return false;
    }
  }

  disconnect(): void {
    if (!this.lib) return;
    try { this.lib.func('int JLINK_Halt(void)')(); } catch { }
    this.clearAllBreakpoints();
    this._state = 'disconnected';
  }

  halt(): boolean {
    if (!this.lib) return false;
    try {
      if (this.lib.func('int JLINK_Halt(void)')() === 0) {
        this._state = 'halted';
        return true;
      }
      return false;
    } catch { return false; }
  }

  run(): boolean {
    if (!this.lib) return false;
    try {
      if (this.lib.func('int JLINK_Go(void)')() === 0) {
        this._state = 'running';
        return true;
      }
      return false;
    } catch { return false; }
  }

  step(): boolean {
    if (!this.lib) return false;
    try {
      if (this.lib.func('int JLINK_Step(void)')() === 0) {
        this._state = 'running';
        return true;
      }
      return false;
    } catch { return false; }
  }

  reset(): boolean {
    if (!this.lib) return false;
    try { return this.lib.func('int JLINK_Reset(void)')() === 0; }
    catch { return false; }
  }

  resetHalt(): boolean {
    if (!this.lib) return false;
    try { return this.lib.func('int JLINK_ResetHalt(void)')() === 0; }
    catch { return false; }
  }

  isHalted(): boolean {
    if (!this.lib || this._state === 'disconnected') return false;
    try { return this.lib.func('int JLINK_IsHalted(void)')() !== 0; }
    catch { return false; }
  }

  probeInterface(): boolean {
    if (!this.lib) return false;
    try {
      const func = this.lib.func('int JLINK_ReadMemU32(uint32, uint32, uint32*)');
      const buf = new Uint32Array(1);
      return func(0x08000000, 1, buf) >= 0;
    } catch { return false; }
  }

  readMemoryU32(address: number, count: number): Uint32Array | null {
    if (!this.lib) return null;
    try {
      const func = this.lib.func('int JLINK_ReadMemU32(uint32, uint32, uint32*)');
      const buf = new Uint32Array(count);
      const ret = func(address, count, buf);
      return ret >= 0 ? buf : null;
    } catch { return null; }
  }

  readMemory(address: number, size: number): Uint8Array | null {
    if (!this.lib) return null;
    try {
      const func = this.lib.func('int JLINK_ReadMem(uint32, uint32, uint8*)');
      const buf = new Uint8Array(size);
      const ret = func(address, size, buf);
      return ret >= 0 ? buf : null;
    } catch { return null; }
  }

  writeMemoryU32(address: number, data: number[]): boolean {
    if (!this.lib) return false;
    try {
      const func = this.lib.func('int JLINK_WriteMemU32(uint32, uint32, uint32*)');
      return func(address, data.length, new Uint32Array(data)) >= 0;
    } catch { return false; }
  }

  readRegister(regIndex: number): number | null {
    if (!this.lib) return null;
    try {
      const func = this.lib.func('int JLINK_ReadReg(int)');
      const ret = func(regIndex);
      return ret >= 0 ? ret >>> 0 : null;
    } catch { return null; }
  }

  readRegisterDAP(regIndex: number): number | null {
    if (!this.lib) return null;
    try {
      const DCRSR = 0xE000EDF4;
      const DCRDR = 0xE000EDF8;
      const writeFunc = this.lib.func('int JLINK_WriteMemU32(uint32, uint32, uint32*)');
      const readFunc = this.lib.func('int JLINK_ReadMemU32(uint32, uint32, uint32*)');
      const selectVal = new Uint32Array([regIndex | (1 << 16)]);
      if (writeFunc(DCRSR, 1, selectVal) < 0) return null;
      const dataBuf = new Uint32Array(1);
      if (readFunc(DCRDR, 1, dataBuf) < 0) return null;
      return dataBuf[0] >>> 0;
    } catch { return null; }
  }

  readAllRegisters(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, idx] of Object.entries(REG_INDEXES)) {
      const val = this.readRegister(idx);
      if (val !== null) result[name] = val;
    }
    return result;
  }

  writeRegister(regIndex: number, value: number): boolean {
    if (!this.lib) return false;
    try { return this.lib.func('int JLINK_WriteReg(int, uint32)')(regIndex, value) === 0; }
    catch { return false; }
  }

  setBreakpoint(address: number): number | null {
    if (!this.lib) return null;
    try {
      for (let i = 0; i < this.bpSlots.length; i++) {
        if (this.bpSlots[i] === null) {
          const ret = this.lib.func('int JLINK_SetBP(uint32_t, uint32_t)')(i, address >>> 0);
          if (ret >= 0) {
            this.bpSlots[i] = address;
            return i;
          }
        }
      }
      return null;
    } catch { return null; }
  }

  clearBreakpoint(index: number): boolean {
    if (!this.lib) return false;
    try {
      if (!this.isHalted()) {
        this.halt();
      }
      const ret = this.lib.func('int JLINK_ClrBP(uint32_t)')(index);
      if (ret >= 0) {
        if (index >= 0 && index < this.bpSlots.length) {
          this.bpSlots[index] = null;
        }
        return true;
      }
      return false;
    } catch { return false; }
  }

  clearAllBreakpoints(): void {
    for (let i = 0; i < 6; i++) {
      try {
        const ret = this.lib?.func('int JLINK_ClrBP(uint32_t)')(i);
        if (typeof ret === 'number' && ret >= 0 && i < this.bpSlots.length) {
          this.bpSlots[i] = null;
        }
      } catch { }
    }
  }

  clearBreakpointAtAddr(addr: number): number | null {
    const index = this.bpSlots.indexOf(addr);
    if (index < 0) return null;
    if (this.clearBreakpoint(index)) return index;
    return null;
  }

  getVersion(): string {
    if (!this.lib) return 'N/A';
    try {
      const ver = this.lib.func('int JLINK_GetDLLVersion(void)')();
      return `V${(ver >>> 8) & 0xFF}.${ver & 0xFF}`;
    } catch { return 'N/A'; }
  }
}