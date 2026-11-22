import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { isIP } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { RMLinkClient } from '../../clients/rmlink/rmlink-client.mjs';
import { log } from '../utils/logger';
import { parseElf32LoadSegments } from './cmsis-dap-flasher';
import type { FlashTargetDefinition } from './cmsis-dap-flasher';
import { CmsisDapHelperClient, findDefaultHelperPath } from './cmsis-dap-helper-channel';
import type { CmsisDapDeviceInfo } from './cmsis-dap-helper-channel';
import type { DebugSessionConfig, OzoneCommandResult } from './types';

export type FlashBackendPreference = 'auto' | 'native' | 'openocd';

// Share upstream drivers across variants. Limit this table to configurations for
// which a single bank of internal Flash can be selected from the device name.
export function resolveOpenOcdTarget(device: string): string | undefined {
  const model = device.trim().toUpperCase();
  const targets: ReadonlyArray<readonly [RegExp, string]> = [
    [/^STM32F103[C-R][468BCDE](?:[THUY]\d[A-Z\d]*)?$/, 'stm32f1x'],
    [/^STM32F10[1357][V-Z][CDE](?:[THUY]\d[A-Z\d]*)?$/, 'stm32f1x'],
    [/^STM32F4(?:01|05|07|11|12|13|15|17)[A-Z][BCEFGH](?:[THUY]\d[A-Z\d]*)?$/, 'stm32f4x'],
    [/^STM32H72[35][A-Z][EG](?:[THUY]\d[A-Z\d]*)?$/, 'stm32h7x'],
    [/^STM32G0(?:30|31|41|50|51|61|70|71|81)[A-Z][468BCDE](?:[THUY]\d[A-Z\d]*)?$/, 'stm32g0x'],
    [/^STM32G4(?:31|41|71|73|74|83|84|91|A1)[A-Z][68BCE](?:[THUY]\d[A-Z\d]*)?$/, 'stm32g4x'],
  ];
  return targets.find(([pattern]) => pattern.test(model))?.[1];
}

type ProbeConnection =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'usb'; transport: 'hid' | 'usb_bulk'; serial?: string; vid: string; pid: string; interfaceNumber?: number };

class OpenOcdFlashError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function invalidConfig(message: string): never {
  throw new OpenOcdFlashError('InvalidConfiguration', message);
}

export function parseOpenOcdEndpoint(address: string): { kind: 'tcp'; host: string; port: number } {
  const match = /^(?:\[([a-fA-F0-9:]+)\]|([a-zA-Z0-9][a-zA-Z0-9.-]*))(?::(\d+))?$/.exec(address.trim());
  if (!match || (match[1] && isIP(match[1]) !== 6)) invalidConfig('CMSIS-DAP TCP 地址应为 host[:port] 或 [IPv6]:port');
  const port = Number(match[3] ?? 3241);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalidConfig('CMSIS-DAP TCP 端口超出范围');
  return { kind: 'tcp', host: match[1] || match[2]!, port };
}

interface RMLinkDeviceStatus {
  device_id: string;
  paired: boolean;
  connected: boolean;
  active_transport?: string;
  transport?: string;
  address?: string;
}

/** Uses the public connector management API. Restore its auto-connect state
 * after the exclusive standard CMSIS-DAP connection has closed. */
export class RMLinkProbeHandoff {
  private detached = false;
  constructor(
    private readonly client: RMLinkClient,
    readonly deviceId: string,
    readonly debugConfig: Pick<DebugSessionConfig, 'cmsisDapTransport' | 'cmsisDapPath' | 'cmsisDapSerial'>,
  ) {}

  static async prepare(deviceId?: string, client = new RMLinkClient()): Promise<RMLinkProbeHandoff> {
    const status = await client.init() as { devices?: RMLinkDeviceStatus[] };
    const devices = (status.devices ?? []).filter(row => row.paired && row.connected && (!deviceId || row.device_id === deviceId));
    if (devices.length !== 1) {
      throw new OpenOcdFlashError(devices.length ? 'AmbiguousDevice' : 'DeviceNotFound',
        devices.length ? '有多台 RMLink 在线，请指定 rmlinkDeviceId' : 'RMLink 连接服务中没有匹配的在线设备');
    }
    const device = devices[0]!;
    const transport = device.active_transport || device.transport;
    if (transport === 'wifi') {
      const endpoint = parseOpenOcdEndpoint(device.address || '');
      if (endpoint.host === '0.0.0.0') invalidConfig('RMLink 当前没有可用的 Wi-Fi 地址');
      return new RMLinkProbeHandoff(client, device.device_id, { cmsisDapTransport: 'tcp', cmsisDapPath: device.address });
    }
    if (transport === 'usb') {
      const usb = await client.request<{ devices?: Array<{ device_id: string; usb_serial: string }> }>('GET', '/usb-devices');
      const serial = usb.devices?.find(row => row.device_id === device.device_id)?.usb_serial;
      if (!serial) invalidConfig('无法确认该 RMLink 的 USB 序列号');
      return new RMLinkProbeHandoff(client, device.device_id, { cmsisDapTransport: 'winusb', cmsisDapSerial: serial });
    }
    return invalidConfig('无法确认 RMLink 当前使用的传输');
  }

  async acquire(): Promise<void> {
    if (this.detached) return;
    const result = await this.client.request<{ connected: boolean }>('POST', '/disconnect', { device_id: this.deviceId });
    if (result.connected !== false) throw new OpenOcdFlashError('TargetBusy', 'RMLink 连接服务未释放探针');
    this.detached = true;
  }

  async release(): Promise<void> {
    if (!this.detached) return;
    const result = await this.client.request<{ connected: boolean }>('POST', '/connect', { device_id: this.deviceId });
    if (!result.connected) throw new OpenOcdFlashError('RMLinkConnectFailed', 'RMLink 连接服务恢复自动连接后，探针尚未上线');
    this.detached = false;
  }
}

async function selectProbe(config: DebugSessionConfig): Promise<ProbeConnection> {
  const transport = config.cmsisDapTransport ?? 'auto';
  if (transport === 'tcp') return parseOpenOcdEndpoint(config.cmsisDapPath ?? '');
  // Enumerate without opening the target. This translates Windows device paths
  // to the VID/PID and serial OpenOCD uses and prevents a different probe winning.
  const helper = new CmsisDapHelperClient(findDefaultHelperPath());
  try {
    const started = await helper.start(transport);
    if (!started.ok) throw new OpenOcdFlashError(started.errorCode || 'HelperStartFailed', started.message);
    const result = await helper.request<{ devices: CmsisDapDeviceInfo[] }>('enumDevices', {
      transport, vid: config.cmsisDapVid, pid: config.cmsisDapPid, serial: config.cmsisDapSerial, path: config.cmsisDapPath,
    });
    if (!result.ok) throw new OpenOcdFlashError(result.errorCode || 'DeviceNotFound', result.message);
    const devices = result.data?.devices ?? [];
    if (devices.length !== 1) throw new OpenOcdFlashError(devices.length ? 'AmbiguousDevice' : 'DeviceNotFound',
      devices.length ? '检测到多个 CMSIS-DAP 探针，请指定序列号或传输类型' : '没有找到匹配的 CMSIS-DAP 探针');
    const device = devices[0]!;
    if (!/^(?:0x)?[a-f\d]{4}$/i.test(device.vid) || !/^(?:0x)?[a-f\d]{4}$/i.test(device.pid)) {
      invalidConfig('无法识别 USB 探针的 VID/PID');
    }
    const id = (value: string) => '0x' + value.replace(/^0x/i, '');
    const usbBulk = device.transport === 'winusb' || device.transport === 'cmsis-dap-v2';
    const interfaceNumber = usbBulk && device.interfaceNumber >= 0 && device.interfaceNumber < 256 ? device.interfaceNumber : undefined;
    return { kind: 'usb', transport: usbBulk ? 'usb_bulk' : 'hid', serial: device.serial || undefined,
      vid: id(device.vid), pid: id(device.pid), interfaceNumber };
  } finally {
    await helper.dispose(false);
  }
}

function quoteTcl(value: string): string {
  if (/[\0\r\n]/.test(value)) invalidConfig('探针序列号包含控制字符');
  return '"' + value.replace(/[\\["$\]]/g, '\\$&') + '"';
}

export function adapterCommands(probe: ProbeConnection): string[] {
  if (probe.kind === 'tcp') return [
    'cmsis-dap backend tcp',
    'cmsis-dap tcp host ' + quoteTcl(probe.host),
    'cmsis-dap tcp port ' + probe.port,
  ];
  return [
    'cmsis-dap backend ' + probe.transport,
    'adapter usb vid_pid ' + probe.vid + ' ' + probe.pid,
    ...(probe.serial ? ['adapter serial ' + quoteTcl(probe.serial)] : []),
    ...(probe.interfaceNumber !== undefined ? ['cmsis-dap usb interface ' + probe.interfaceNumber] : []),
  ];
}

interface FlashImageRange { start: number; end: number }

export function validateOpenOcdImage(image: Uint8Array, target?: FlashTargetDefinition): FlashImageRange[] {
  const ranges = parseElf32LoadSegments(image).filter(segment => segment.fileSize).map(segment => ({
    start: segment.loadAddress,
    end: segment.loadAddress + segment.fileSize,
  })).sort((left, right) => left.start - right.start);
  const flashBase = target?.flashBase ?? 0x08000000;
  const flashEnd = flashBase + (target?.flashSize ?? 0x200000);
  if (!ranges.length || ranges.some((range, index) =>
    range.start < flashBase || range.end > flashEnd || (index > 0 && range.start < ranges[index - 1]!.end))) {
    invalidConfig('ELF 加载段必须位于片内 Flash 且地址不可重叠');
  }
  return ranges;
}

function programScript(ranges: FlashImageRange[], speedKHz: number, target?: FlashTargetDefinition): string {
  const hex = (address: number) => '0x' + address.toString(16);
  const preflight = target?.preflight;
  const identity = preflight ? [
    'set devid [lindex [read_memory ' + hex(preflight.idcodeAddress) + ' 32 1] 0]',
    'set capacity [lindex [read_memory ' + hex(preflight.flashSizeRegisterAddress) + ' 16 1] 0]',
    'if {($devid & 0xfff) != ' + hex(preflight.deviceId) + ' || $capacity != '
      + preflight.expectedFlashSizeKiB + '} { error "Flash target identity or capacity mismatch" }',
  ] : [];
  return [
    'if {[catch {',
    '  adapter speed ' + speedKHz,
    '  init',
    '  reset init',
    // Some upstream targets change the adapter clock in reset-init.
    '  adapter speed ' + speedKHz,
    ...identity.map(line => '  ' + line),
    '  flash probe 0',
    '  set bank [lindex [capture {flash list}] 0]',
    '  set flash_start [dict get $bank base]',
    '  set flash_end [expr {$flash_start + [dict get $bank size]}]',
    ...ranges.map(({ start, end }) =>
      '  if {' + hex(start) + ' < $flash_start || ' + hex(end) + ' > $flash_end} { error "ELF exceeds the probed internal Flash bank" }'),
    '  echo ORBIT_FLASH_WRITING',
    '  flash write_image erase firmware.elf 0 elf',
    '  echo ORBIT_FLASH_VERIFYING',
    '  verify_image firmware.elf 0 elf',
    '} outcome]} {',
    '  echo "ORBIT_FLASH_ERROR: $outcome"',
    '  shutdown error',
    '}',
    'echo ORBIT_FLASH_VERIFIED',
    'shutdown',
  ].join('\n');
}

async function runProgrammer(
  executable: string, args: string[], cwd: string, signal: AbortSignal, onProgress: (line: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let detail = '';
    let error: Error | undefined;
    let verified = false;
    const abort = () => {
      error ??= new OpenOcdFlashError('RequestCancelled', '烧录已取消');
      child.kill();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => {
      error ??= new OpenOcdFlashError('OutcomeUnknown', '烧录超时，Flash 内容可能已改变');
      child.kill();
    }, 180_000);
    for (const stream of [child.stdout, child.stderr]) {
      let partial = '';
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        const lines = (partial + chunk).split(/\r?\n/);
        partial = lines.pop()!.slice(-4096);
        for (const line of lines) {
          log.dll('[cmsis-dap] [openocd] ' + line);
          detail = (detail + '\n' + line).slice(-4000);
          if (line.trim() === 'ORBIT_FLASH_WRITING') onProgress('正在擦除并写入固件');
          if (line.trim() === 'ORBIT_FLASH_VERIFYING') onProgress('正在校验已写入的固件');
          if (line.trim() === 'ORBIT_FLASH_VERIFIED') verified = true;
        }
      });
    }
    child.once('error', cause => { error ??= cause; });
    // close follows both process exit and stdio drain. Only then may the caller
    // restore Connector or allow another process to open this probe.
    child.once('close', code => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (code !== 0 || !verified) reject(new OpenOcdFlashError('FlashFailed',
        detail.split('\n').reverse().find(line => line.includes('ORBIT_FLASH_ERROR:'))?.trim()
          || '烧录进程未报告校验通过，可在 Orbit 调试日志查看详情'));
      else resolve();
    });
  });
}

export async function flashWithOpenOcd(
  config: DebugSessionConfig, elfPath: string, script: string, target: FlashTargetDefinition | undefined,
  signal: AbortSignal, onProgress: (line: string) => void,
): Promise<OzoneCommandResult> {
  const start = performance.now();
  let directory: string | undefined;
  try {
    if (config.interface !== 'SWD') invalidConfig('OpenOCD 烧录当前仅支持 SWD');
    if (!Number.isSafeInteger(config.speedKHz) || config.speedKHz < 1 || config.speedKHz > 50_000) {
      invalidConfig('无效的 SWD 时钟');
    }
    if (resolveOpenOcdTarget(config.device) !== script) invalidConfig('不支持该芯片的自动烧录配置');
    const root = path.resolve(__dirname, '..', 'out', 'openocd');
    const executable = path.join(root, 'bin', 'openocd.exe');
    const scripts = path.join(root, 'share', 'openocd', 'scripts');
    await fs.access(executable);
    await fs.access(path.join(scripts, 'target', script + '.cfg'));
    const image = await fs.readFile(elfPath);
    const ranges = validateOpenOcdImage(image, target);
    signal.throwIfAborted();
    const probe = await selectProbe(config);
    signal.throwIfAborted();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-openocd-'));
    await fs.writeFile(path.join(directory, 'firmware.elf'), image);
    await fs.writeFile(path.join(directory, 'program.tcl'), programScript(ranges, config.speedKHz, target));
    const commands = ['gdb port disabled', 'tcl port disabled', 'telnet port disabled', 'transport select swd',
      ...adapterCommands(probe)];
    const args = ['-s', scripts, '-f', 'interface/cmsis-dap.cfg', ...commands.flatMap(command => ['-c', command]),
      '-f', 'target/' + script + '.cfg', '-f', 'program.tcl'];
    log.dll('[cmsis-dap] [openocd] start target=' + config.device + ' script=' + script + ' transport=' + probe.kind);
    await runProgrammer(executable, args, directory, signal, onProgress);
    return { ok: true, data: { message: '固件烧录及校验完成' }, elapsedMs: performance.now() - start };
  } catch (error) {
    return { ok: false, errorCode: error instanceof OpenOcdFlashError ? error.code : signal.aborted ? 'RequestCancelled' : 'FlashFailed',
      error: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - start };
  } finally {
    if (directory) {
      await fs.unlink(path.join(directory, 'firmware.elf')).catch(() => {});
      await fs.unlink(path.join(directory, 'program.tcl')).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  }
}
