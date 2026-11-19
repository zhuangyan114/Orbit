import type { CmsisDapRttChannelDescriptor, CmsisDapRttMemoryRange } from '../ozone-backend/cmsis-dap-helper-channel';
import { validateRttMemoryRanges } from '../ozone-backend/rtt-contract';
import type { SymbolCatalog, SymbolNode, SymbolType } from '../symbols/symbol-catalog';
import { symbolByteSize, symbolType } from '../symbols/symbol-catalog';

export interface StructFieldOffset {
  readonly offset: number;
  readonly size: number;
}

export interface SystemViewGlobalsLayout {
  readonly address: number;
  readonly size: number;
  readonly mainContextOffset: number;
  readonly mainContextSize: number;
  readonly fields: {
    readonly enableState: StructFieldOffset;
    readonly upChannel: StructFieldOffset;
    readonly sysFreq: StructFieldOffset;
    readonly cpuFreq: StructFieldOffset;
    readonly ramBaseAddress: StructFieldOffset;
    readonly lastTxTimeStamp: StructFieldOffset;
    readonly downChannel?: StructFieldOffset;
    readonly dropCount?: StructFieldOffset;
    readonly packetCount?: StructFieldOffset;
  };
  /**
   * 依据 `SEGGER_SYSVIEW_CORE_CONTEXT` 编译期结构判定：
   * - `true`: 存在 `PacketCount` 且无 `DownChannel`/`DropCount`（`POST_MORTEM_MODE == 1`）
   * - `false`: 存在 `DownChannel` 与 `DropCount` 且无 `PacketCount`（`POST_MORTEM_MODE == 0`）
   * - `'unknown'`: 无法从结构确定
   */
  readonly postMortemCompiled: boolean | 'unknown';
}

export interface FixtureCaptureLayout {
  readonly address: number;
  readonly size: number;
  readonly fields: {
    readonly mode: StructFieldOffset;
    readonly frozen: StructFieldOffset;
    readonly generation: StructFieldOffset;
    readonly size: StructFieldOffset;
    readonly wrOff: StructFieldOffset;
    readonly rdOff: StructFieldOffset;
    readonly enabledBeforeStop: StructFieldOffset;
    readonly buffer: StructFieldOffset;
  };
}

export interface SystemViewTargetMetadataLayout {
  readonly elfSha256: string;
  readonly rttControlBlockAddress?: number;
  readonly globals?: SystemViewGlobalsLayout;
  readonly globalsUnavailableReason?: string;
  readonly fixtureCapture?: FixtureCaptureLayout;
  readonly fixtureCaptureUnavailableReason?: string;
}

export interface SystemViewGlobalsValues {
  readonly enableState: number;
  readonly upChannel: number;
  readonly sysFreq: number;
  readonly cpuFreq: number;
  readonly ramBaseAddress: number;
  readonly lastTxTimeStamp: number;
  readonly downChannel?: number;
  readonly dropCount?: number;
  readonly packetCount?: number;
}

export interface FixtureCaptureValues {
  readonly mode: number;
  readonly frozen: number;
  readonly generation: number;
  readonly size: number;
  readonly wrOff: number;
  readonly rdOff: number;
  readonly enabledBeforeStop: number;
  readonly buffer: number;
}

export interface RingReadSlice {
  readonly address: number;
  readonly size: number;
  readonly ringOffset: number;
}

export interface RingReadPlan {
  readonly empty: boolean;
  readonly wrapped: boolean;
  readonly prefixOverwritten: boolean;
  readonly retainedBytes: number;
  readonly slices: readonly RingReadSlice[];
}

export function isRangeInMemoryRanges(
  address: number,
  size: number,
  ranges: readonly CmsisDapRttMemoryRange[],
): boolean {
  if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) || address < 0 || size <= 0) {
    return false;
  }
  if (address + size > 0x1_0000_0000) {
    return false;
  }
  for (const r of ranges) {
    if (address >= r.address && (address - r.address) <= r.size && size <= r.size - (address - r.address)) {
      return true;
    }
  }
  return false;
}

function resolveUniqueGlobal(
  catalog: SymbolCatalog,
  name: string,
  requireType = true,
): { ok: true; node: SymbolNode } | { ok: false; reason: string } {
  const matches = catalog.roots.filter(node => node.expression === name);
  if (matches.length === 0) {
    return { ok: false, reason: `ELF symbol '${name}' not found` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ELF symbol '${name}' is ambiguous (${matches.length} matches)` };
  }
  const node = matches[0];
  if (node.address === undefined || !Number.isSafeInteger(node.address) || node.address <= 0 || node.unavailable) {
    return { ok: false, reason: node.unavailable || `ELF symbol '${name}' has no valid address` };
  }
  if (requireType && !node.typeOffset) {
    return { ok: false, reason: `DWARF type unavailable for '${name}'` };
  }
  return { ok: true, node };
}

function resolveStructMember(
  catalog: SymbolCatalog,
  structType: SymbolType,
  fieldName: string,
  expectedSizes: readonly number[],
): { ok: true; member: StructFieldOffset; typeOffset: string } | { ok: false; reason: string } {
  const matches = structType.fields?.filter(f => f.name === fieldName) ?? [];
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: matches.length === 0
        ? `Missing DWARF field '${structType.name || '<struct>'}.${fieldName}'`
        : `Ambiguous DWARF field '${structType.name || '<struct>'}.${fieldName}'`,
    };
  }
  const field = matches[0];
  const size = symbolByteSize(catalog, field.typeOffset);
  if (field.bitSize || !Number.isSafeInteger(field.byteOffset) || field.byteOffset < 0
    || !expectedSizes.includes(size) || field.byteOffset + size > structType.byteSize) {
    return {
      ok: false,
      reason: `Invalid DWARF field '${structType.name || '<struct>'}.${fieldName}' (offset=${field.byteOffset}, size=${size})`,
    };
  }
  return {
    ok: true,
    member: { offset: field.byteOffset, size },
    typeOffset: field.typeOffset,
  };
}

/**
 * 从 ELF/DWARF 符号树编译 SystemView 目标元数据布局，不硬编码任何偏移量。
 */
export function compileSystemViewTargetMetadata(
  catalog: SymbolCatalog,
  elfSha256: string,
): SystemViewTargetMetadataLayout {
  let rttControlBlockAddress: number | undefined;
  const rttMatch = resolveUniqueGlobal(catalog, '_SEGGER_RTT', false);
  if (rttMatch.ok) {
    rttControlBlockAddress = rttMatch.node.address! >>> 0;
  }

  let globals: SystemViewGlobalsLayout | undefined;
  let globalsUnavailableReason: string | undefined;
  const globalsMatch = resolveUniqueGlobal(catalog, '_SYSVIEW_Globals');
  if (!globalsMatch.ok) {
    globalsUnavailableReason = globalsMatch.reason;
  } else {
    const gNode = globalsMatch.node;
    const gType = symbolType(catalog, gNode.typeOffset);
    if (!gType || gType.kind !== 'struct' || gType.byteSize <= 0 || gType.byteSize > 4096) {
      globalsUnavailableReason = 'Invalid DWARF struct type for _SYSVIEW_Globals';
    } else {
      const mainCtxField = gType.fields?.filter(f => f.name === 'MainContext') ?? [];
      if (mainCtxField.length !== 1) {
        globalsUnavailableReason = 'Missing or ambiguous _SYSVIEW_Globals.MainContext';
      } else {
        const ctxOffset = mainCtxField[0].byteOffset;
        const ctxType = symbolType(catalog, mainCtxField[0].typeOffset);
        if (!ctxType || ctxType.kind !== 'struct' || ctxType.byteSize <= 0 || ctxOffset + ctxType.byteSize > gType.byteSize) {
          globalsUnavailableReason = 'Invalid DWARF type for _SYSVIEW_Globals.MainContext';
        } else {
          const enableState = resolveStructMember(catalog, ctxType, 'EnableState', [1]);
          const upChannel = resolveStructMember(catalog, ctxType, 'UpChannel', [1]);
          const sysFreq = resolveStructMember(catalog, ctxType, 'SysFreq', [4]);
          const cpuFreq = resolveStructMember(catalog, ctxType, 'CPUFreq', [4]);
          const ramBaseAddress = resolveStructMember(catalog, ctxType, 'RAMBaseAddress', [4]);
          const lastTxTimeStamp = resolveStructMember(catalog, ctxType, 'LastTxTimeStamp', [4]);
          const requiredErrors = [enableState, upChannel, sysFreq, cpuFreq, ramBaseAddress, lastTxTimeStamp]
            .filter((r): r is { ok: false; reason: string } => !r.ok);
          if (requiredErrors.length > 0) {
            globalsUnavailableReason = requiredErrors[0].reason;
          } else {
            const downChannel = resolveStructMember(catalog, ctxType, 'DownChannel', [1]);
            const dropCount = resolveStructMember(catalog, ctxType, 'DropCount', [4]);
            const packetCount = resolveStructMember(catalog, ctxType, 'PacketCount', [4]);

            let postMortemCompiled: boolean | 'unknown' = 'unknown';
            if (packetCount.ok && !downChannel.ok && !dropCount.ok) {
              postMortemCompiled = true;
            } else if (!packetCount.ok && downChannel.ok && dropCount.ok) {
              postMortemCompiled = false;
            }

            globals = {
              address: gNode.address! >>> 0,
              size: gType.byteSize,
              mainContextOffset: ctxOffset,
              mainContextSize: ctxType.byteSize,
              fields: {
                enableState: (enableState as { ok: true; member: StructFieldOffset }).member,
                upChannel: (upChannel as { ok: true; member: StructFieldOffset }).member,
                sysFreq: (sysFreq as { ok: true; member: StructFieldOffset }).member,
                cpuFreq: (cpuFreq as { ok: true; member: StructFieldOffset }).member,
                ramBaseAddress: (ramBaseAddress as { ok: true; member: StructFieldOffset }).member,
                lastTxTimeStamp: (lastTxTimeStamp as { ok: true; member: StructFieldOffset }).member,
                ...(downChannel.ok ? { downChannel: downChannel.member } : {}),
                ...(dropCount.ok ? { dropCount: dropCount.member } : {}),
                ...(packetCount.ok ? { packetCount: packetCount.member } : {}),
              },
              postMortemCompiled,
            };
          }
        }
      }
    }
  }

  let fixtureCapture: FixtureCaptureLayout | undefined;
  let fixtureCaptureUnavailableReason: string | undefined;
  const fixtureMatch = resolveUniqueGlobal(catalog, 'fixtureCapture');
  if (!fixtureMatch.ok) {
    fixtureCaptureUnavailableReason = fixtureMatch.reason;
  } else {
    const fNode = fixtureMatch.node;
    const fType = symbolType(catalog, fNode.typeOffset);
    if (!fType || fType.kind !== 'struct' || fType.byteSize <= 0 || fType.byteSize > 256) {
      fixtureCaptureUnavailableReason = 'Invalid DWARF struct type for fixtureCapture';
    } else {
      const mode = resolveStructMember(catalog, fType, 'mode', [4]);
      const frozen = resolveStructMember(catalog, fType, 'frozen', [4]);
      const generation = resolveStructMember(catalog, fType, 'generation', [4]);
      const size = resolveStructMember(catalog, fType, 'size', [4]);
      const wrOff = resolveStructMember(catalog, fType, 'wrOff', [4]);
      const rdOff = resolveStructMember(catalog, fType, 'rdOff', [4]);
      const enabledBeforeStop = resolveStructMember(catalog, fType, 'enabledBeforeStop', [4]);
      const buffer = resolveStructMember(catalog, fType, 'buffer', [4]);
      const firstErr = [mode, frozen, generation, size, wrOff, rdOff, enabledBeforeStop, buffer]
        .find((r): r is { ok: false; reason: string } => !r.ok);
      if (firstErr) {
        fixtureCaptureUnavailableReason = firstErr.reason;
      } else {
        fixtureCapture = {
          address: fNode.address! >>> 0,
          size: fType.byteSize,
          fields: {
            mode: (mode as { ok: true; member: StructFieldOffset }).member,
            frozen: (frozen as { ok: true; member: StructFieldOffset }).member,
            generation: (generation as { ok: true; member: StructFieldOffset }).member,
            size: (size as { ok: true; member: StructFieldOffset }).member,
            wrOff: (wrOff as { ok: true; member: StructFieldOffset }).member,
            rdOff: (rdOff as { ok: true; member: StructFieldOffset }).member,
            enabledBeforeStop: (enabledBeforeStop as { ok: true; member: StructFieldOffset }).member,
            buffer: (buffer as { ok: true; member: StructFieldOffset }).member,
          },
        };
      }
    }
  }

  return {
    elfSha256,
    ...(rttControlBlockAddress !== undefined ? { rttControlBlockAddress } : {}),
    ...(globals ? { globals } : {}),
    ...(globalsUnavailableReason ? { globalsUnavailableReason } : {}),
    ...(fixtureCapture ? { fixtureCapture } : {}),
    ...(fixtureCaptureUnavailableReason ? { fixtureCaptureUnavailableReason } : {}),
  };
}

function readUIntLE(bytes: Uint8Array, offset: number, size: number): number {
  if (offset < 0 || offset + size > bytes.length) {
    throw new RangeError(`Field read out of bounds (offset=${offset}, size=${size}, len=${bytes.length})`);
  }
  if (size === 1) {
    return bytes[offset];
  }
  if (size === 4) {
    return (
      bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24)
    ) >>> 0;
  }
  throw new RangeError(`Unsupported scalar size ${size}`);
}

export function decodeSystemViewGlobals(
  bytes: Uint8Array,
  layout: SystemViewGlobalsLayout,
): SystemViewGlobalsValues {
  const base = layout.mainContextOffset;
  if (bytes.length < base + layout.mainContextSize) {
    throw new RangeError(`_SYSVIEW_Globals short read: expected >=${base + layout.mainContextSize}, got ${bytes.length}`);
  }
  const f = layout.fields;
  return {
    enableState: readUIntLE(bytes, base + f.enableState.offset, f.enableState.size),
    upChannel: readUIntLE(bytes, base + f.upChannel.offset, f.upChannel.size),
    sysFreq: readUIntLE(bytes, base + f.sysFreq.offset, f.sysFreq.size),
    cpuFreq: readUIntLE(bytes, base + f.cpuFreq.offset, f.cpuFreq.size),
    ramBaseAddress: readUIntLE(bytes, base + f.ramBaseAddress.offset, f.ramBaseAddress.size),
    lastTxTimeStamp: readUIntLE(bytes, base + f.lastTxTimeStamp.offset, f.lastTxTimeStamp.size),
    ...(f.downChannel ? { downChannel: readUIntLE(bytes, base + f.downChannel.offset, f.downChannel.size) } : {}),
    ...(f.dropCount ? { dropCount: readUIntLE(bytes, base + f.dropCount.offset, f.dropCount.size) } : {}),
    ...(f.packetCount ? { packetCount: readUIntLE(bytes, base + f.packetCount.offset, f.packetCount.size) } : {}),
  };
}

export function decodeFixtureCapture(
  bytes: Uint8Array,
  layout: FixtureCaptureLayout,
): FixtureCaptureValues {
  if (bytes.length < layout.size) {
    throw new RangeError(`fixtureCapture short read: expected >=${layout.size}, got ${bytes.length}`);
  }
  const f = layout.fields;
  return {
    mode: readUIntLE(bytes, f.mode.offset, f.mode.size),
    frozen: readUIntLE(bytes, f.frozen.offset, f.frozen.size),
    generation: readUIntLE(bytes, f.generation.offset, f.generation.size),
    size: readUIntLE(bytes, f.size.offset, f.size.size),
    wrOff: readUIntLE(bytes, f.wrOff.offset, f.wrOff.size),
    rdOff: readUIntLE(bytes, f.rdOff.offset, f.rdOff.size),
    enabledBeforeStop: readUIntLE(bytes, f.enabledBeforeStop.offset, f.enabledBeforeStop.size),
    buffer: readUIntLE(bytes, f.buffer.offset, f.buffer.size),
  };
}

export function validateSysViewBufferDescriptor(
  desc: CmsisDapRttChannelDescriptor,
  ramRanges: readonly CmsisDapRttMemoryRange[],
): { ok: true } | { ok: false; errorCode: string; message: string } {
  const checked = validateRttMemoryRanges(ramRanges, false, 'ramRanges');
  if (!checked.ok) {
    return { ok: false, errorCode: 'UnsupportedCapability', message: checked.message };
  }
  if (!desc.valid || desc.status !== 'valid') {
    return {
      ok: false,
      errorCode: desc.errorCode || 'RttInvalidBufferLayout',
      message: desc.errorMessage || `SysView ${desc.direction} descriptor ${desc.index} is not valid`,
    };
  }
  if (desc.bufferAddress <= 0 || desc.bufferSize < 2) {
    return {
      ok: false,
      errorCode: 'RttInvalidBufferLayout',
      message: `SysView ${desc.direction} descriptor has invalid buffer geometry (addr=0x${desc.bufferAddress.toString(16)}, size=${desc.bufferSize})`,
    };
  }
  if (desc.wrOff < 0 || desc.wrOff >= desc.bufferSize || desc.rdOff < 0 || desc.rdOff >= desc.bufferSize) {
    return {
      ok: false,
      errorCode: 'RttInvalidBufferLayout',
      message: `SysView ${desc.direction} descriptor offsets out of range (wrOff=${desc.wrOff}, rdOff=${desc.rdOff}, size=${desc.bufferSize})`,
    };
  }
  if (!isRangeInMemoryRanges(desc.bufferAddress, desc.bufferSize, checked.normalized)) {
    return {
      ok: false,
      errorCode: 'RttInvalidBufferLayout',
      message: `SysView ${desc.direction} buffer [0x${desc.bufferAddress.toString(16)}, +${desc.bufferSize}) lies outside valid target RAM ranges`,
    };
  }
  return { ok: true };
}

/**
 * 计算 Single-Shot 或 Post-Mortem 模式下的合法环形保留读取区间（严格不修改 RdOff）：
 * - `wrOff === rdOff`: 无保留数据
 * - `wrOff > rdOff`: `[rdOff, wrOff)`
 * - `wrOff < rdOff`: `[rdOff, bufferSize)` 接 `[0, wrOff)`
 */
export function computeRingReadPlan(
  mode: 'single-shot' | 'post-mortem',
  bufferAddress: number,
  bufferSize: number,
  wrOff: number,
  rdOff: number,
): { ok: true; plan: RingReadPlan } | { ok: false; errorCode: string; message: string } {
  if (!Number.isInteger(bufferAddress) || bufferAddress <= 0 || !Number.isInteger(bufferSize) || bufferSize < 2) {
    return { ok: false, errorCode: 'RttInvalidBufferLayout', message: 'Invalid RTT buffer address or size' };
  }
  if (!Number.isInteger(wrOff) || wrOff < 0 || wrOff >= bufferSize
    || !Number.isInteger(rdOff) || rdOff < 0 || rdOff >= bufferSize) {
    return { ok: false, errorCode: 'RttInvalidBufferLayout', message: `Invalid RTT pointers wrOff=${wrOff} rdOff=${rdOff} size=${bufferSize}` };
  }
  if (wrOff === rdOff) {
    return {
      ok: true,
      plan: {
        empty: true,
        wrapped: false,
        prefixOverwritten: false,
        retainedBytes: 0,
        slices: [],
      },
    };
  }
  if (wrOff > rdOff) {
    const retainedBytes = wrOff - rdOff;
    return {
      ok: true,
      plan: {
        empty: false,
        wrapped: false,
        prefixOverwritten: mode === 'post-mortem' && rdOff !== 0,
        retainedBytes,
        slices: [
          {
            address: (bufferAddress + rdOff) >>> 0,
            size: retainedBytes,
            ringOffset: rdOff,
          },
        ],
      },
    };
  }
  const tailSize = bufferSize - rdOff;
  const headSize = wrOff;
  const slices: RingReadSlice[] = [
    {
      address: (bufferAddress + rdOff) >>> 0,
      size: tailSize,
      ringOffset: rdOff,
    },
  ];
  if (headSize > 0) {
    slices.push({
      address: bufferAddress >>> 0,
      size: headSize,
      ringOffset: 0,
    });
  }
  return {
    ok: true,
    plan: {
      empty: false,
      wrapped: true,
      prefixOverwritten: true,
      retainedBytes: tailSize + headSize,
      slices,
    },
  };
}
