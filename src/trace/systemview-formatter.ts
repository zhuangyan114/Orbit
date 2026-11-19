import {
  decodeFloatBits,
  FREERTOS_API_NAMES,
  FREERTOS_TRACE_MACRO_PARAMS,
  IdResolutionStatus,
  SYSTEMVIEW_FREERTOS_API_OFFSET,
} from './systemview-protocol';
import type {
  DecodedEventPayload,
  DecodedOsParam,
  DecodedSystemViewPacket,
  PacketCategory,
  SchemaReliability,
  SegmentReliability,
  TimeAnchorStatus,
} from './systemview-decoder';
import type {
  ExecutionContextKind,
  LabelSource,
  TaskInstanceSummary,
} from './systemview-reconstructor';

export const DEFAULT_FORMATTER_LIMITS = {
  maxInputChars: 4096,
  maxOutputChars: 4096,
  maxSpecifiers: 64,
  maxWidth: 64,
  maxPrecision: 32,
  maxPrintArgs: 64,
  maxRawPayloadPreviewBytes: 64,
} as const;

export interface FormatterLimits {
  readonly maxInputChars: number;
  readonly maxOutputChars: number;
  readonly maxSpecifiers: number;
  readonly maxWidth: number;
  readonly maxPrecision: number;
  readonly maxPrintArgs: number;
  readonly maxRawPayloadPreviewBytes: number;
}

export type FormatAddressStatus =
  | 'resolved-elf-rodata'
  | 'null-address'
  | 'no-elf-loaded'
  | 'elf-sha-mismatch'
  | 'outside-rodata'
  | 'unterminated-or-overlong';

export interface VerifiedElfRodataLookup {
  readonly elfSha256?: string;
  readonly expectedSha256?: string;
  lookupCString(address: number, maxBytes: number):
    | { readonly status: 'resolved'; readonly text: string }
    | { readonly status: 'outside-rodata' | 'unterminated-or-overlong' };
}

export interface TraceEventDiagnosticDto {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface TraceApiParamDto {
  readonly name: string;
  readonly kind: 'shrunk-id' | 'u32';
  readonly rawValue: number;
  readonly rawHex: string;
  readonly idResolution?: IdResolutionStatus;
  readonly resolvedId?: number;
  readonly resolvedHex?: string;
  readonly resolvedLabel?: string;
  readonly resolvedLabelSource?: string;
  readonly enumNote?: string;
  readonly pointerNote?: string;
}

export interface TraceFreeRtosApiDetailsDto {
  readonly apiId: number;
  readonly apiName?: string;
  readonly interpretation: 'matched' | 'unmapped-api' | 'param-mismatch';
  readonly params: readonly TraceApiParamDto[];
  readonly rawPayloadHex?: string;
  readonly sourceNote: string;
  readonly missingReason?: string;
}

export interface TraceTerminalEntryDto {
  readonly kind: 'print-formatted' | 'ex-print-elf';
  readonly logLevel: number;
  readonly logLevelLabel: string;
  readonly append: boolean;
  readonly renderedText: string;
  readonly formatSource: 'packet-inline' | 'elf-rodata' | 'unresolved-address';
  readonly rawFormatText?: string;
  readonly stringAddress?: number;
  readonly stringAddressHex?: string;
  readonly addressStatus?: FormatAddressStatus;
  readonly args: readonly number[];
  readonly rawArgBytesHex?: string;
  readonly warnings: readonly string[];
}

export interface TraceResolvedRefDto {
  readonly role: string;
  readonly idStatus: IdResolutionStatus;
  readonly rawValue: number;
  readonly address?: number;
  readonly addressHex?: string;
  readonly label?: string;
  readonly source?: string;
}

export interface TraceEventSliceContext {
  readonly contextKind: ExecutionContextKind;
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly irqId?: number;
  readonly isrDepth: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
}

export interface TraceEventMetadataContext {
  readonly tasksByInstanceId: ReadonlyMap<string, TaskInstanceSummary>;
  readonly tasksByBootAddr: ReadonlyMap<string, TaskInstanceSummary>;
  readonly irqNamesByBoot: ReadonlyMap<number, ReadonlyMap<number, string>>;
  readonly markerNamesByBoot: ReadonlyMap<number, ReadonlyMap<number, string>>;
  readonly resourceNamesByBoot: ReadonlyMap<number, ReadonlyMap<number, string>>;
  readonly moduleNamesByBoot: ReadonlyMap<number, ReadonlyMap<number, string>>;
  readonly dataNamesByBoot: ReadonlyMap<number, ReadonlyMap<number, { readonly name: string; readonly unit?: string }>>;
}

export interface TraceEventDto {
  readonly eventKey: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly packetIndexInSegment: number;
  readonly streamByteOffset: number;
  readonly byteLength: number;
  readonly eventId: number;
  readonly eventName: string;
  readonly category: PacketCategory;
  readonly schemaReliability: SchemaReliability;
  readonly deltaTicks: number;
  readonly relTicks: string;
  readonly absTicks?: string;
  readonly ns?: string;
  readonly sysFreqHz?: number;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly timestampWrapped: boolean;
  readonly contextKind: ExecutionContextKind | 'unknown';
  readonly contextKey?: string;
  readonly contextLabel?: string;
  readonly contextLabelSource?: LabelSource;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly irqId?: number;
  readonly isrDepth: number;
  readonly nestedIsr: boolean;
  readonly summary: string;
  readonly apiDetails?: TraceFreeRtosApiDetailsDto;
  readonly terminalEntry?: TraceTerminalEntryDto;
  readonly resolvedReferences?: readonly TraceResolvedRefDto[];
  readonly rawPayloadHex?: string;
  readonly diagnostics: readonly TraceEventDiagnosticDto[];
}

export function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function formatHexBytesPreview(bytes: Uint8Array, maxBytes = 64): { hex: string; truncated: boolean } {
  const cap = Math.max(0, Math.min(bytes.length, maxBytes));
  const parts: string[] = [];
  for (let i = 0; i < cap; i++) {
    parts.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return {
    hex: parts.join(' '),
    truncated: bytes.length > cap,
  };
}

/**
 * 过滤或转义不可见 C0/DEL 控制字符与 ESC 序列，防止终端控制符注入。
 * 保留换行（归一化 `\r\n` -> `\n`）与制表符 `\t`。
 */
export function sanitizeTerminalText(raw: string, maxChars: number = DEFAULT_FORMATTER_LIMITS.maxOutputChars): {
  text: string;
  truncated: boolean;
  sanitizedControlCount: number;
} {
  let out = '';
  let sanitizedControlCount = 0;
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= maxChars) {
      truncated = true;
      break;
    }
    const code = raw.charCodeAt(i);
    if (code === 0x0d) {
      if (i + 1 < raw.length && raw.charCodeAt(i + 1) === 0x0a) {
        i++;
      }
      out += '\n';
    } else if (code === 0x0a || code === 0x09) {
      out += raw[i];
    } else if (code < 0x20 || code === 0x7f) {
      sanitizedControlCount++;
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += raw[i];
    }
  }
  if (truncated) {
    out = out.slice(0, Math.max(0, maxChars - 14)) + '…[truncated]';
  }
  return { text: out, truncated, sanitizedControlCount };
}

export function logLevelToLabel(level: number): string {
  switch (level) {
    case 0:
      return 'LOG';
    case 1:
      return 'WARNING';
    case 2:
      return 'ERROR';
    default:
      return `LVL_${level}`;
  }
}

function padFormattedValue(
  body: string,
  prefix: string,
  width: number,
  leftAlign: boolean,
  zeroPad: boolean,
): string {
  const totalLen = prefix.length + body.length;
  if (width <= totalLen) {
    return prefix + body;
  }
  const padCount = width - totalLen;
  if (leftAlign) {
    return prefix + body + ' '.repeat(padCount);
  }
  if (zeroPad) {
    return prefix + '0'.repeat(padCount) + body;
  }
  return ' '.repeat(padCount) + prefix + body;
}

function parseFiniteFormatSpec(
  text: string,
  percentIdx: number,
  maxWidth: number,
  maxPrecision: number,
): {
  readonly nextIdx: number;
  readonly isDoublePercent: boolean;
  readonly valid: boolean;
  readonly flags: {
    readonly leftAlign: boolean;
    readonly plus: boolean;
    readonly space: boolean;
    readonly alt: boolean;
    readonly zero: boolean;
  };
  readonly widthFromArg: boolean;
  readonly width: number;
  readonly widthClamped: boolean;
  readonly hasPrecision: boolean;
  readonly precisionFromArg: boolean;
  readonly precision: number;
  readonly precisionClamped: boolean;
  readonly lengthMod: string;
  readonly specifier: string;
} {
  let i = percentIdx + 1;
  if (i >= text.length) {
    return {
      nextIdx: i,
      isDoublePercent: false,
      valid: false,
      flags: { leftAlign: false, plus: false, space: false, alt: false, zero: false },
      widthFromArg: false,
      width: 0,
      widthClamped: false,
      hasPrecision: false,
      precisionFromArg: false,
      precision: 0,
      precisionClamped: false,
      lengthMod: '',
      specifier: '',
    };
  }
  if (text[i] === '%') {
    return {
      nextIdx: i + 1,
      isDoublePercent: true,
      valid: true,
      flags: { leftAlign: false, plus: false, space: false, alt: false, zero: false },
      widthFromArg: false,
      width: 0,
      widthClamped: false,
      hasPrecision: false,
      precisionFromArg: false,
      precision: 0,
      precisionClamped: false,
      lengthMod: '',
      specifier: '%',
    };
  }

  let leftAlign = false;
  let plus = false;
  let space = false;
  let alt = false;
  let zero = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '-') leftAlign = true;
    else if (ch === '+') plus = true;
    else if (ch === ' ') space = true;
    else if (ch === '#') alt = true;
    else if (ch === '0') zero = true;
    else break;
    i++;
  }

  let widthFromArg = false;
  let width = 0;
  let widthClamped = false;
  if (i < text.length && text[i] === '*') {
    widthFromArg = true;
    i++;
  } else {
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      const digit = text.charCodeAt(i) - 48;
      if (width <= maxWidth) {
        width = width * 10 + digit;
        if (width > maxWidth) {
          width = maxWidth;
          widthClamped = true;
        }
      } else {
        widthClamped = true;
      }
      i++;
    }
  }

  let hasPrecision = false;
  let precisionFromArg = false;
  let precision = 0;
  let precisionClamped = false;
  if (i < text.length && text[i] === '.') {
    hasPrecision = true;
    i++;
    if (i < text.length && text[i] === '*') {
      precisionFromArg = true;
      i++;
    } else {
      while (i < text.length && text[i] >= '0' && text[i] <= '9') {
        const digit = text.charCodeAt(i) - 48;
        if (precision <= maxPrecision) {
          precision = precision * 10 + digit;
          if (precision > maxPrecision) {
            precision = maxPrecision;
            precisionClamped = true;
          }
        } else {
          precisionClamped = true;
        }
        i++;
      }
    }
  }

  let lengthMod = '';
  if (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === 'll' || two === 'hh') {
      lengthMod = two;
      i += 2;
    } else if (text[i] === 'l' || text[i] === 'h' || text[i] === 'z' || text[i] === 't') {
      lengthMod = text[i];
      i++;
    }
  }

  const spec = i < text.length ? text[i] : '';
  const KNOWN_SPECS = 'diuxXobBpcfFeEgGsn';
  if (!spec || !KNOWN_SPECS.includes(spec)) {
    return {
      nextIdx: spec ? i + 1 : i,
      isDoublePercent: false,
      valid: false,
      flags: { leftAlign, plus, space, alt, zero },
      widthFromArg,
      width,
      widthClamped,
      hasPrecision,
      precisionFromArg,
      precision,
      precisionClamped,
      lengthMod,
      specifier: spec,
    };
  }

  return {
    nextIdx: i + 1,
    isDoublePercent: false,
    valid: true,
    flags: { leftAlign, plus, space, alt, zero },
    widthFromArg,
    width,
    widthClamped,
    hasPrecision,
    precisionFromArg,
    precision,
    precisionClamped,
    lengthMod,
    specifier: spec,
  };
}

export interface FormattedPrintResult {
  readonly renderedText: string;
  readonly warnings: readonly string[];
  readonly consumedArgs: number;
  readonly truncated: boolean;
}

/**
 * 按有限词法安全解释 SEGGER SystemView `PRINT_FORMATTED` 格式串。
 * - 仅操作已解码的 32-bit scalar `args`，绝不执行任何表达式、脚本或任意代码；
 * - 严格限制输入/输出长度、说明符数与宽度/精度，阻止内存膨胀与终端控制注入；
 * - `%n` 明令禁止；`%s` 不解引用任意目标指针并给出可辨警告；
 * - 对目标侧已格式化并含字面 `%` 的无参数日志（`args.length === 0`）安全保留字面文本。
 */
export function formatSystemViewPrintFormatted(
  rawText: string,
  args: readonly number[],
  limits: Partial<FormatterLimits> = {},
): FormattedPrintResult {
  const cfg: FormatterLimits = { ...DEFAULT_FORMATTER_LIMITS, ...limits };
  const warnings: string[] = [];
  let text = rawText;
  let inputTruncated = false;
  if (text.length > cfg.maxInputChars) {
    text = text.slice(0, cfg.maxInputChars);
    inputTruncated = true;
    warnings.push(`格式串长度超出上限 ${cfg.maxInputChars} 字符并已截断`);
  }

  // 协议层面无标志区分“目标侧已格式化文本”与“零参数 host print”；
  // 当 args.length === 0 时，无损保留全部字面字符（含 %d/%x/%%/%s/%n），仅执行长度上限与控制字符清理。
  if (args.length === 0) {
    const sanitized = sanitizeTerminalText(text, cfg.maxOutputChars);
    if (sanitized.sanitizedControlCount > 0) {
      warnings.push(`已转义 ${sanitized.sanitizedControlCount} 个终端控制字符`);
    }
    if (inputTruncated || sanitized.truncated) {
      warnings.push(`终端输出超出上限 ${cfg.maxOutputChars} 字符并已截断`);
    }
    return {
      renderedText: sanitized.text,
      warnings,
      consumedArgs: 0,
      truncated: inputTruncated || sanitized.truncated,
    };
  }

  let out = '';
  let argIdx = 0;
  let specCount = 0;
  let outputTruncated = inputTruncated;

  const appendOut = (chunk: string): boolean => {
    if (out.length >= cfg.maxOutputChars) {
      outputTruncated = true;
      return false;
    }
    if (out.length + chunk.length > cfg.maxOutputChars) {
      out += chunk.slice(0, cfg.maxOutputChars - out.length);
      outputTruncated = true;
      return false;
    }
    out += chunk;
    return true;
  };

  let i = 0;
  while (i < text.length) {
    const pct = text.indexOf('%', i);
    if (pct < 0) {
      appendOut(text.slice(i));
      break;
    }
    if (pct > i) {
      if (!appendOut(text.slice(i, pct))) break;
    }

    // 无参数目标已格式化文本（如 SEGGER_SYSVIEW_Warn("literal=<sample> %") 或 "50% done"）遇到孤立或后随空格的 `%` 时原样保留字面文本
    if (args.length === 0 && (pct + 1 >= text.length || text[pct + 1] === ' ')) {
      if (!appendOut('%')) break;
      i = pct + 1;
      continue;
    }

    const parsed = parseFiniteFormatSpec(text, pct, cfg.maxWidth, cfg.maxPrecision);

    if (!parsed.valid) {
      const rawFragment = text.slice(pct, parsed.nextIdx);
      if (args.length > 0 || parsed.specifier !== '') {
        warnings.push(`不可识别或截断的格式说明符 "${rawFragment}"，按字面输出`);
      }
      if (!appendOut(rawFragment)) break;
      i = parsed.nextIdx;
      continue;
    }

    if (parsed.isDoublePercent) {
      if (args.length === 0 && !text.slice(0, pct).includes('%')) {
        // 目标无参字面串也可能是 "%%" 或单 "%"，此处仅折叠标准 "%%"
      }
      if (!appendOut('%')) break;
      i = parsed.nextIdx;
      continue;
    }

    specCount++;
    if (specCount > cfg.maxSpecifiers) {
      warnings.push(`格式说明符数量超过上限 ${cfg.maxSpecifiers}，停止解析后续说明符`);
      appendOut(text.slice(pct));
      break;
    }

    if (parsed.widthClamped) {
      warnings.push(`格式宽度超出上限 ${cfg.maxWidth} 并已钳制`);
    }
    if (parsed.precisionClamped) {
      warnings.push(`格式精度超出上限 ${cfg.maxPrecision} 并已钳制`);
    }

    let effLeft = parsed.flags.leftAlign;
    let effWidth = parsed.width;
    if (parsed.widthFromArg) {
      if (argIdx >= args.length) {
        warnings.push(`格式宽度 '*' 缺少参数 #${argIdx}`);
        if (!appendOut(`<missing-width#${argIdx}>`)) break;
        i = parsed.nextIdx;
        continue;
      }
      const wSigned = args[argIdx++] | 0;
      if (wSigned < 0) {
        effLeft = true;
      }
      effWidth = Math.min(cfg.maxWidth, Math.abs(wSigned));
      if (Math.abs(wSigned) > cfg.maxWidth) {
        warnings.push(`动态格式宽度 ${wSigned} 超出上限 ${cfg.maxWidth} 并已钳制`);
      }
    }

    let effHasPrec = parsed.hasPrecision;
    let effPrec = parsed.precision;
    if (parsed.precisionFromArg) {
      if (argIdx >= args.length) {
        warnings.push(`格式精度 '.*' 缺少参数 #${argIdx}`);
        if (!appendOut(`<missing-prec#${argIdx}>`)) break;
        i = parsed.nextIdx;
        continue;
      }
      const pSigned = args[argIdx++] | 0;
      if (pSigned < 0) {
        effHasPrec = false;
        effPrec = 0;
      } else {
        effPrec = Math.min(cfg.maxPrecision, pSigned);
        if (pSigned > cfg.maxPrecision) {
          warnings.push(`动态格式精度 ${pSigned} 超出上限 ${cfg.maxPrecision} 并已钳制`);
        }
      }
    }

    if (parsed.specifier === 'n') {
      warnings.push('已阻止危险写回说明符 %n');
      if (argIdx < args.length) argIdx++;
      if (!appendOut('<%n:blocked>')) break;
      i = parsed.nextIdx;
      continue;
    }

    if (argIdx >= args.length) {
      warnings.push(`格式说明符 %${parsed.specifier} 缺少参数 #${argIdx}（共提供 ${args.length} 个参数）`);
      if (!appendOut(`<missing-arg#${argIdx}>`)) break;
      i = parsed.nextIdx;
      continue;
    }

    const rawArg = args[argIdx++] >>> 0;
    const zeroPad = parsed.flags.zero && !effLeft && !effHasPrec;

    if (parsed.specifier === 's') {
      warnings.push(`%s 目标指针 ${formatHex32(rawArg)} 不可从流内安全解引用`);
      if (!appendOut(`<str@${formatHex32(rawArg)}:不可解析指针>`)) break;
      i = parsed.nextIdx;
      continue;
    }

    let formattedPiece = '';
    switch (parsed.specifier) {
      case 'd':
      case 'i': {
        const sVal = rawArg | 0;
        const neg = sVal < 0;
        const absDigits = Math.abs(sVal).toString(10);
        const body = effHasPrec ? absDigits.padStart(effPrec, '0') : absDigits;
        const prefix = neg ? '-' : parsed.flags.plus ? '+' : parsed.flags.space ? ' ' : '';
        formattedPiece = padFormattedValue(body, prefix, effWidth, effLeft, zeroPad);
        break;
      }
      case 'u': {
        const digits = rawArg.toString(10);
        const body = effHasPrec ? digits.padStart(effPrec, '0') : digits;
        formattedPiece = padFormattedValue(body, '', effWidth, effLeft, zeroPad);
        break;
      }
      case 'x':
      case 'X': {
        const upper = parsed.specifier === 'X';
        let digits = rawArg.toString(16);
        if (upper) digits = digits.toUpperCase();
        const body = effHasPrec ? digits.padStart(effPrec, '0') : digits;
        const prefix = parsed.flags.alt && rawArg !== 0 ? (upper ? '0X' : '0x') : '';
        formattedPiece = padFormattedValue(body, prefix, effWidth, effLeft, zeroPad);
        break;
      }
      case 'o': {
        const digits = rawArg.toString(8);
        const body = effHasPrec ? digits.padStart(effPrec, '0') : digits;
        const prefix = parsed.flags.alt && !body.startsWith('0') ? '0' : '';
        formattedPiece = padFormattedValue(body, prefix, effWidth, effLeft, zeroPad);
        break;
      }
      case 'b':
      case 'B': {
        const digits = rawArg.toString(2);
        const body = effHasPrec ? digits.padStart(effPrec, '0') : digits;
        const prefix = parsed.flags.alt && rawArg !== 0 ? (parsed.specifier === 'B' ? '0B' : '0b') : '';
        formattedPiece = padFormattedValue(body, prefix, effWidth, effLeft, zeroPad);
        break;
      }
      case 'p': {
        const digits = rawArg.toString(16).padStart(8, '0');
        formattedPiece = padFormattedValue(digits, '0x', effWidth, effLeft, zeroPad);
        break;
      }
      case 'c': {
        const chCode = rawArg & 0xff;
        const chStr = chCode >= 0x20 && chCode < 0x7f ? String.fromCharCode(chCode) : `\\x${chCode.toString(16).padStart(2, '0')}`;
        formattedPiece = padFormattedValue(chStr, '', effWidth, effLeft, false);
        break;
      }
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G': {
        const fVal = decodeFloatBits(rawArg);
        const p = effHasPrec ? Math.min(12, effPrec) : 6;
        let numStr: string;
        if (!Number.isFinite(fVal)) {
          numStr = String(fVal);
        } else if (parsed.specifier === 'e' || parsed.specifier === 'E') {
          numStr = fVal.toExponential(p);
          if (parsed.specifier === 'E') numStr = numStr.toUpperCase();
        } else if (parsed.specifier === 'g' || parsed.specifier === 'G') {
          numStr = Number(fVal.toPrecision(Math.max(1, p))).toString();
          if (parsed.specifier === 'G') numStr = numStr.toUpperCase();
        } else {
          numStr = fVal.toFixed(p);
        }
        const neg = numStr.startsWith('-');
        const absBody = neg ? numStr.slice(1) : numStr;
        const prefix = neg ? '-' : parsed.flags.plus ? '+' : parsed.flags.space ? ' ' : '';
        formattedPiece = padFormattedValue(absBody, prefix, effWidth, effLeft, zeroPad && Number.isFinite(fVal));
        break;
      }
      default:
        formattedPiece = text.slice(pct, parsed.nextIdx);
        break;
    }

    if (!appendOut(formattedPiece)) break;
    i = parsed.nextIdx;
  }

  if (argIdx < args.length) {
    const extraCount = args.length - argIdx;
    warnings.push(`存在 ${extraCount} 个未消耗格式参数（共 ${args.length} 个）`);
  }

  const sanitized = sanitizeTerminalText(out, cfg.maxOutputChars);
  if (sanitized.sanitizedControlCount > 0) {
    warnings.push(`已转义 ${sanitized.sanitizedControlCount} 个终端控制字符`);
  }
  if (outputTruncated || sanitized.truncated) {
    warnings.push(`终端输出超出上限 ${cfg.maxOutputChars} 字符并已截断`);
  }

  return {
    renderedText: sanitized.text,
    warnings,
    consumedArgs: argIdx,
    truncated: outputTruncated || sanitized.truncated,
  };
}

export function decodePrintElfVarintArgs(
  rawArgBytes: Uint8Array,
  maxArgs: number = DEFAULT_FORMATTER_LIMITS.maxPrintArgs,
): { readonly args: readonly number[]; readonly warnings: readonly string[] } {
  const args: number[] = [];
  const warnings: string[] = [];
  let pos = 0;
  while (pos < rawArgBytes.length) {
    if (args.length >= maxArgs) {
      warnings.push(`EX_PRINT_ELF 参数个数超过上限 ${maxArgs}，剩余 ${rawArgBytes.length - pos} 字节未解析`);
      break;
    }
    let val = 0;
    let shift = 0;
    let count = 0;
    let done = false;
    while (pos < rawArgBytes.length) {
      const b = rawArgBytes[pos++];
      count++;
      if (count > 5) {
        warnings.push(`EX_PRINT_ELF 参数 #${args.length} varint 超过 5 字节上限`);
        pos = rawArgBytes.length;
        break;
      }
      if (count === 5 && (b & 0x80) === 0 && b > 0x0f) {
        warnings.push(`EX_PRINT_ELF 参数 #${args.length} 第 5 字节 0x${b.toString(16)} 溢出 uint32`);
        pos = rawArgBytes.length;
        break;
      }
      val = (val | ((b & 0x7f) << shift)) >>> 0;
      if ((b & 0x80) === 0) {
        done = true;
        break;
      }
      shift += 7;
    }
    if (done) {
      args.push(val >>> 0);
    } else if (pos >= rawArgBytes.length && count > 0) {
      warnings.push(`EX_PRINT_ELF 参数 #${args.length} varint 截断`);
    }
  }
  return { args, warnings };
}

export function interpretExPrintElf(
  stringAddress: number,
  options: number,
  rawArgBytes: Uint8Array,
  rodataLookup?: VerifiedElfRodataLookup,
  limits: Partial<FormatterLimits> = {},
): TraceTerminalEntryDto {
  const cfg: FormatterLimits = { ...DEFAULT_FORMATTER_LIMITS, ...limits };
  const logLevel = options & 0x3f;
  const append = (options & (1 << 6)) !== 0;
  const addrHex = formatHex32(stringAddress);
  const { args, warnings: argWarnings } = decodePrintElfVarintArgs(rawArgBytes, cfg.maxPrintArgs);
  const { hex: rawArgBytesHex } = formatHexBytesPreview(rawArgBytes, cfg.maxRawPayloadPreviewBytes);
  const warnings = [...argWarnings];

  let addressStatus: FormatAddressStatus;
  let resolvedFmt: string | undefined;

  if (!Number.isInteger(stringAddress) || stringAddress < 0 || stringAddress > 0xffffffff) {
    addressStatus = 'outside-rodata';
    warnings.push(`EX_PRINT_ELF 非法字符串地址 ${String(stringAddress)}`);
  } else if (stringAddress === 0) {
    addressStatus = 'null-address';
    warnings.push('EX_PRINT_ELF 字符串地址为 NULL (0x00000000)');
  } else if (!rodataLookup) {
    addressStatus = 'no-elf-loaded';
    warnings.push(`EX_PRINT_ELF 地址 ${addrHex} 不可解析：当前录制/会话未提供可验证的 ELF 只读段`);
  } else if (
    rodataLookup.expectedSha256 &&
    rodataLookup.elfSha256 &&
    rodataLookup.expectedSha256 !== rodataLookup.elfSha256
  ) {
    addressStatus = 'elf-sha-mismatch';
    warnings.push(`EX_PRINT_ELF 地址 ${addrHex} 不可解析：ELF SHA256 不匹配`);
  } else {
    const res = rodataLookup.lookupCString(stringAddress, cfg.maxInputChars);
    if (res.status === 'resolved') {
      addressStatus = 'resolved-elf-rodata';
      resolvedFmt = res.text;
    } else {
      addressStatus = res.status;
      warnings.push(
        res.status === 'outside-rodata'
          ? `EX_PRINT_ELF 异常字符串地址 ${addrHex}：不在已验证 ELF 只读段 (.rodata) 内`
          : `EX_PRINT_ELF 地址 ${addrHex} 字符串未以 NUL 结尾或超出长度上限`,
      );
    }
  }

  if (addressStatus === 'resolved-elf-rodata' && resolvedFmt !== undefined) {
    const formatted = formatSystemViewPrintFormatted(resolvedFmt, args, cfg);
    warnings.push(...formatted.warnings);
    return {
      kind: 'ex-print-elf',
      logLevel,
      logLevelLabel: logLevelToLabel(logLevel),
      append,
      renderedText: formatted.renderedText,
      formatSource: 'elf-rodata',
      rawFormatText: resolvedFmt,
      stringAddress,
      stringAddressHex: addrHex,
      addressStatus,
      args,
      ...(rawArgBytesHex ? { rawArgBytesHex } : {}),
      warnings,
    };
  }

  const argsSuffix = args.length > 0 ? ` args=[${args.join(', ')}]` : '';
  return {
    kind: 'ex-print-elf',
    logLevel,
    logLevelLabel: logLevelToLabel(logLevel),
    append,
    renderedText: `[未解析 ELF 格式串 @${addrHex} (${addressStatus})${argsSuffix}]`,
    formatSource: 'unresolved-address',
    stringAddress,
    stringAddressHex: addrHex,
    addressStatus,
    args,
    ...(rawArgBytesHex ? { rawArgBytesHex } : {}),
    warnings,
  };
}

function lookupTaskLabelByAddress(
  bootGeneration: number,
  address: number,
  meta: TraceEventMetadataContext,
): { label?: string; source?: string } {
  const t = meta.tasksByBootAddr.get(`${bootGeneration}:${address >>> 0}`);
  if (t?.name) {
    return { label: t.name, source: `task-info (${t.nameSource})` };
  }
  return {};
}

function lookupResourceLabelByAddress(
  bootGeneration: number,
  address: number,
  meta: TraceEventMetadataContext,
): { label?: string; source?: string } {
  const resName = meta.resourceNamesByBoot.get(bootGeneration)?.get(address >>> 0);
  if (resName) {
    return { label: resName, source: 'name-resource' };
  }
  return {};
}

function explainEnumParam(apiId: number, paramName: string, rawValue: number): string | undefined {
  if (paramName === 'ticksToWait' || paramName === 'ticksToDelay') {
    if (rawValue >>> 0 === 0xffffffff) return 'portMAX_DELAY (0xFFFFFFFF)';
  }
  if ((apiId === 30 || apiId === 31) && paramName === 'action') {
    switch (rawValue) {
      case 0: return 'eNoAction';
      case 1: return 'eSetBits';
      case 2: return 'eIncrement';
      case 3: return 'eSetValueWithOverwrite';
      case 4: return 'eSetValueWithoutOverwrite';
      default: return `unknown-eNotifyAction(${rawValue})`;
    }
  }
  if (apiId === 58 && paramName === 'copyPosition') {
    switch (rawValue) {
      case 0: return 'queueSEND_TO_BACK';
      case 1: return 'queueSEND_TO_FRONT';
      case 2: return 'queueOVERWRITE';
      default: return `unknown-copyPosition(${rawValue})`;
    }
  }
  if (apiId === 60 && paramName === 'isQueue') {
    return rawValue === 0 ? 'Semaphore/Mutex (0)' : rawValue === 1 ? 'Queue/Peek (1)' : `isQueue=${rawValue}`;
  }
  if (apiId === 83 && paramName === 'queueType') {
    switch (rawValue) {
      case 0: return 'queueQUEUE_TYPE_BASE';
      case 1: return 'queueQUEUE_TYPE_MUTEX';
      case 2: return 'queueQUEUE_TYPE_COUNTING_SEMAPHORE';
      case 3: return 'queueQUEUE_TYPE_BINARY_SEMAPHORE';
      case 4: return 'queueQUEUE_TYPE_RECURSIVE_MUTEX';
      default: return `unknown-queueType(${rawValue})`;
    }
  }
  return undefined;
}

function formatStopReadyCause(cause: number): string {
  if (cause === 4) return 'delayed (1<<2)';
  if (cause === 27) return 'suspended ((3<<3)|3)';
  return `cause=${cause}`;
}

export function explainFreeRtosOsEvent(
  bootGeneration: number,
  decoded: Extract<DecodedEventPayload, { kind: 'os-freertos' }>,
  meta: TraceEventMetadataContext,
  rodataLookup?: VerifiedElfRodataLookup,
): TraceFreeRtosApiDetailsDto {
  const { apiId, apiName, params, rawPayload, interpretation } = decoded;
  const rawPreview = rawPayload.length > 0 ? formatHexBytesPreview(rawPayload, 64) : undefined;
  const rawPayloadHex = rawPreview ? (rawPreview.truncated ? `${rawPreview.hex} …` : rawPreview.hex) : undefined;
  const sourceNote = 'SEGGER_SYSVIEW_FreeRTOS.h (apiID_OFFSET=32)';

  if (interpretation !== 'matched' || !params) {
    const schemaDefined = Boolean(FREERTOS_TRACE_MACRO_PARAMS[apiId]);
    const missingReason =
      interpretation === 'unmapped-api'
        ? (apiName
            ? `首版仅包含 SEGGER_SYSVIEW_FreeRTOS.h 已映射 trace* 宏参数；${apiName} (apiId=${apiId}) 未定义宏参数签名`
            : `未知 FreeRTOS API 编号 apiId=${apiId}（超出 1..111 已知表）`)
        : `API ${apiName ?? apiId} 参数字节长度与预期宏签名（${schemaDefined ? FREERTOS_TRACE_MACRO_PARAMS[apiId].length : 0} 个参数）不匹配`;
    return {
      apiId,
      apiName,
      interpretation,
      params: [],
      ...(rawPayloadHex ? { rawPayloadHex } : {}),
      sourceNote,
      missingReason,
    };
  }

  const outParams: TraceApiParamDto[] = params.map((p: DecodedOsParam) => {
    const rawHex = formatHex32(p.rawValue);
    let resolvedLabel: string | undefined;
    let resolvedLabelSource: string | undefined;
    let pointerNote: string | undefined;

    if (p.kind === 'shrunk-id' && p.resolvedId !== undefined) {
      if (p.name === 'taskId') {
        const hit = lookupTaskLabelByAddress(bootGeneration, p.resolvedId, meta);
        resolvedLabel = hit.label;
        resolvedLabelSource = hit.source;
      } else if (p.name === 'queueId' || p.name === 'bufferId' || p.name === 'bufferOrZeroId') {
        if (p.resolvedId === 0) {
          resolvedLabel = 'NULL';
          resolvedLabelSource = 'zero-handle';
        } else {
          const hit = lookupResourceLabelByAddress(bootGeneration, p.resolvedId, meta);
          resolvedLabel = hit.label;
          resolvedLabelSource = hit.source;
        }
      }
    } else if (p.kind === 'u32' && p.name.endsWith('Ptr')) {
      if (p.rawValue === 0) {
        pointerNote = 'NULL (0x00000000)';
      } else if (p.name === 'queueNamePtr') {
        if (rodataLookup) {
          const res = rodataLookup.lookupCString(p.rawValue, 128);
          if (res.status === 'resolved') {
            resolvedLabel = res.text;
            resolvedLabelSource = 'elf-rodata';
          } else {
            pointerNote = res.status === 'outside-rodata' ? '异常字符串地址（不在 ELF 只读段）' : '字符串未终止或超限';
          }
        } else {
          pointerNote = '未提供 ELF 只读段，不可解引用';
        }
      } else {
        const taskHit = lookupTaskLabelByAddress(bootGeneration, p.rawValue, meta);
        if (taskHit.label) {
          resolvedLabel = taskHit.label;
          resolvedLabelSource = taskHit.source;
        }
      }
    }

    const enumNote = explainEnumParam(apiId, p.name, p.rawValue);
    return {
      name: p.name,
      kind: p.kind,
      rawValue: p.rawValue,
      rawHex,
      ...(p.idResolution ? { idResolution: p.idResolution } : {}),
      ...(p.resolvedId !== undefined ? { resolvedId: p.resolvedId, resolvedHex: formatHex32(p.resolvedId) } : {}),
      ...(resolvedLabel ? { resolvedLabel, resolvedLabelSource } : {}),
      ...(enumNote ? { enumNote } : {}),
      ...(pointerNote ? { pointerNote } : {}),
    };
  });

  return {
    apiId,
    apiName,
    interpretation,
    params: outParams,
    ...(rawPayloadHex ? { rawPayloadHex } : {}),
    sourceNote,
  };
}

export function buildEmptyMetadataContext(): TraceEventMetadataContext {
  return {
    tasksByInstanceId: new Map(),
    tasksByBootAddr: new Map(),
    irqNamesByBoot: new Map(),
    markerNamesByBoot: new Map(),
    resourceNamesByBoot: new Map(),
    moduleNamesByBoot: new Map(),
    dataNamesByBoot: new Map(),
  };
}

export function formatTraceEventDto(params: {
  readonly pkt: DecodedSystemViewPacket;
  readonly bootGeneration: number;
  readonly meta: TraceEventMetadataContext;
  readonly sliceCtx?: TraceEventSliceContext;
  readonly rodataLookup?: VerifiedElfRodataLookup;
  readonly segmentSysFreqHz?: number;
  readonly limits?: Partial<FormatterLimits>;
}): TraceEventDto {
  const { pkt, bootGeneration, meta, sliceCtx, rodataLookup, segmentSysFreqHz, limits } = params;
  const freq = pkt.sysFreqHz ?? segmentSysFreqHz;
  const ns = pkt.timestampNs ?? (
    pkt.absoluteTicksBigInt !== undefined && freq && freq > 0
      ? ((pkt.absoluteTicksBigInt * 1_000_000_000n) / BigInt(freq)).toString()
      : undefined
  );
  const timeDomain: TraceEventDto['timeDomain'] =
    pkt.timeAnchorStatus === 'anchored-cycles' || pkt.timeAnchorStatus === 'anchored-systime-us'
      ? 'anchored-ticks'
      : pkt.segmentReliability === 'trusted'
        ? 'segment-relative-ticks'
        : 'unknown';

  const diagnostics: TraceEventDiagnosticDto[] = [];
  if (pkt.segmentReliability === 'uncertain') {
    diagnostics.push({
      severity: 'warning',
      code: 'uncertain-segment',
      message: `位于不可信/断段后段 Seg#${pkt.segmentId} (boot=${bootGeneration})`,
    });
  }
  if (pkt.timestampWrapped) {
    diagnostics.push({
      severity: 'info',
      code: 'timestamp-wrap',
      message: '此事件时间戳发生硬件计数器回绕展开',
    });
  }

  let contextKind: TraceEventDto['contextKind'] = sliceCtx?.contextKind ?? 'unknown';
  let contextKey = sliceCtx?.contextKey;
  let contextLabel = sliceCtx?.label;
  let contextLabelSource = sliceCtx?.labelSource;
  let taskInstanceId = sliceCtx?.taskInstanceId;
  let tcbAddress = sliceCtx?.tcbAddress;
  let irqId = sliceCtx?.irqId;
  let isrDepth = sliceCtx?.isrDepth ?? 0;

  // 若是 ISR_ENTER/ISR_EXIT 且未命中 sliceCtx，补充直观 IRQ 标识
  if (pkt.decoded.kind === 'isr-enter' && irqId === undefined) {
    irqId = pkt.decoded.irqId;
    contextKind = 'isr';
    contextLabel = meta.irqNamesByBoot.get(bootGeneration)?.get(irqId) ?? `IRQ#${irqId}`;
    contextLabelSource = meta.irqNamesByBoot.get(bootGeneration)?.has(irqId) ? 'sysdesc' : 'missing';
    isrDepth = Math.max(1, isrDepth);
  }
  if (contextKind === 'isr' && irqId !== undefined && !contextLabel) {
    const sysName = meta.irqNamesByBoot.get(bootGeneration)?.get(irqId);
    if (sysName) {
      contextLabel = sysName;
      contextLabelSource = 'sysdesc';
    }
  }
  if (contextKind === 'task' && tcbAddress !== undefined && !contextLabel) {
    const taskHit = lookupTaskLabelByAddress(bootGeneration, tcbAddress, meta);
    if (taskHit.label) {
      contextLabel = taskHit.label;
      contextLabelSource = 'task-info';
    }
  }

  const nestedIsr = isrDepth > 1;
  const resolvedReferences: TraceResolvedRefDto[] = [];
  let apiDetails: TraceFreeRtosApiDetailsDto | undefined;
  let terminalEntry: TraceTerminalEntryDto | undefined;
  let rawPayloadHex: string | undefined;
  let summary = pkt.eventName;

  const d = pkt.decoded;
  switch (d.kind) {
    case 'overflow': {
      summary = `溢出丢包 rawDropCount=${d.rawDropCount}${d.minDroppedPackets !== undefined ? ` (minDropped=${d.minDroppedPackets})` : ' (精确丢失数 unknown)'}`;
      diagnostics.push({
        severity: 'error',
        code: 'target-overflow',
        message: d.dropCountAnomaly
          ? `目标端溢出计数异常倒退/跳变 (rawDropCount=${d.rawDropCount})`
          : `目标端 SystemView 缓冲溢出 (rawDropCount=${d.rawDropCount})`,
      });
      break;
    }
    case 'isr-enter': {
      const irqName = meta.irqNamesByBoot.get(bootGeneration)?.get(d.irqId);
      summary = `进入中断 ${irqName ? `${irqName} (IRQ#${d.irqId})` : `IRQ#${d.irqId}`}${nestedIsr ? ` [嵌套深度 ${isrDepth}]` : ''}`;
      break;
    }
    case 'isr-exit':
      summary = '退出中断 (ISR_EXIT)';
      break;
    case 'isr-to-scheduler':
      summary = '中断退出至调度器 (ISR_TO_SCHEDULER)';
      break;
    case 'task-start-exec':
    case 'task-start-ready':
    case 'task-create':
    case 'task-terminate': {
      const addrHex = d.taskId !== undefined ? formatHex32(d.taskId) : undefined;
      const tHit = d.taskId !== undefined ? lookupTaskLabelByAddress(bootGeneration, d.taskId, meta) : {};
      resolvedReferences.push({
        role: 'task',
        idStatus: d.idResolution,
        rawValue: d.shrunkTaskId,
        address: d.taskId,
        addressHex: addrHex,
        label: tHit.label,
        source: tHit.source ?? (d.idResolution === 'resolved' ? 'init-shrink-id' : d.idResolution),
      });
      if (d.idResolution !== 'resolved') {
        diagnostics.push({
          severity: 'warning',
          code: 'id-resolution-failed',
          message: `任务 ID shrunk=${d.shrunkTaskId} 地址不可解析 (${d.idResolution})`,
        });
      }
      const targetStr = tHit.label
        ? `${tHit.label} (${addrHex})`
        : addrHex
          ? `${addrHex} [无任务名]`
          : `shrunk=${d.shrunkTaskId} [地址不可解析:${d.idResolution}]`;
      summary = `${pkt.eventName}: ${targetStr}`;
      break;
    }
    case 'task-stop-ready': {
      const addrHex = d.taskId !== undefined ? formatHex32(d.taskId) : undefined;
      const tHit = d.taskId !== undefined ? lookupTaskLabelByAddress(bootGeneration, d.taskId, meta) : {};
      resolvedReferences.push({
        role: 'task',
        idStatus: d.idResolution,
        rawValue: d.shrunkTaskId,
        address: d.taskId,
        addressHex: addrHex,
        label: tHit.label,
        source: tHit.source ?? d.idResolution,
      });
      if (d.idResolution !== 'resolved') {
        diagnostics.push({
          severity: 'warning',
          code: 'id-resolution-failed',
          message: `TASK_STOP_READY 任务 ID shrunk=${d.shrunkTaskId} 地址不可解析 (${d.idResolution})`,
        });
      }
      summary = `${tHit.label ?? addrHex ?? `shrunk=${d.shrunkTaskId}`} · ${formatStopReadyCause(d.cause)}`;
      break;
    }
    case 'task-info': {
      const addrHex = d.taskId !== undefined ? formatHex32(d.taskId) : `shrunk=${d.shrunkTaskId}`;
      resolvedReferences.push({
        role: 'task',
        idStatus: d.idResolution,
        rawValue: d.shrunkTaskId,
        address: d.taskId,
        addressHex: d.taskId !== undefined ? formatHex32(d.taskId) : undefined,
        label: d.name,
        source: 'task-info',
      });
      summary = `任务信息 ${d.name} (${addrHex}, prio=${d.priority})`;
      break;
    }
    case 'stack-info': {
      const addrHex = d.taskId !== undefined ? formatHex32(d.taskId) : `shrunk=${d.shrunkTaskId}`;
      const tHit = d.taskId !== undefined ? lookupTaskLabelByAddress(bootGeneration, d.taskId, meta) : {};
      summary = `栈信息 ${tHit.label ?? addrHex}: base=${formatHex32(d.stackBase)} size=${d.stackSize} B usage=${d.stackUsage} B`;
      break;
    }
    case 'timer-enter': {
      const addrHex = d.timerId !== undefined ? formatHex32(d.timerId) : `shrunk=${d.shrunkTimerId}`;
      const rHit = d.timerId !== undefined ? lookupResourceLabelByAddress(bootGeneration, d.timerId, meta) : {};
      if (d.idResolution !== 'resolved') {
        diagnostics.push({
          severity: 'warning',
          code: 'id-resolution-failed',
          message: `定时器 ID shrunk=${d.shrunkTimerId} 地址不可解析 (${d.idResolution})`,
        });
      }
      summary = `进入定时器 ${rHit.label ? `${rHit.label} (${addrHex})` : addrHex}`;
      break;
    }
    case 'mark-start':
    case 'mark-stop':
    case 'ex-mark': {
      const mName = meta.markerNamesByBoot.get(bootGeneration)?.get(d.markerId);
      summary = `${pkt.eventName}: ${mName ? `${mName} (#${d.markerId})` : `Marker #${d.markerId}`}`;
      break;
    }
    case 'ex-name-marker':
      summary = `命名 Marker #${d.markerId} = "${d.name}"`;
      break;
    case 'name-resource': {
      const addrHex = d.resourceId !== undefined ? formatHex32(d.resourceId) : `shrunk=${d.shrunkResourceId}`;
      summary = `命名资源 ${addrHex} = "${d.name}"`;
      break;
    }
    case 'init':
      summary = `INIT sysFreq=${d.sysFreqHz}Hz cpuFreq=${d.cpuFreqHz}Hz ramBase=${formatHex32(d.ramBaseAddress)} idShift=${d.idShift}`;
      break;
    case 'systime-cycles':
      summary = `SYSTIME_CYCLES = ${d.cycles}`;
      break;
    case 'systime-us':
      summary = `SYSTIME_US = ${d.systimeUs}`;
      break;
    case 'sysdesc':
      summary = `SYSDESC: ${d.rawText.slice(0, 120)}`;
      if (d.parsed.malformedItems.length > 0) {
        diagnostics.push({
          severity: 'warning',
          code: 'sysdesc-malformed-item',
          message: `SYSDESC 含不可解析项: ${d.parsed.malformedItems.join(', ')}`,
        });
      }
      break;
    case 'moduledesc':
      summary = `MODULEDESC #${d.moduleId} (offset=${d.eventOffset}): ${d.description}`;
      break;
    case 'nummodules':
      summary = `NUMMODULES = ${d.numModules}`;
      break;
    case 'data-sample': {
      const info = meta.dataNamesByBoot.get(bootGeneration)?.get(d.dataId);
      summary = `DATA_SAMPLE ${info ? info.name : `#${d.dataId}`}: raw=${formatHex32(d.rawValueBits)} float=${Number.isFinite(d.floatValue) ? d.floatValue : 'NaN'}${info?.unit ? ` ${info.unit}` : ''}`;
      break;
    }
    case 'ex-register-data':
      summary = `EX_REGISTER_DATA #${d.dataId} "${d.name}"${d.unit ? ` (${d.unit})` : ''}`;
      break;
    case 'print-formatted': {
      const formatted = formatSystemViewPrintFormatted(d.text, d.args, limits);
      const lvlLabel = logLevelToLabel(d.logLevel);
      terminalEntry = {
        kind: 'print-formatted',
        logLevel: d.logLevel,
        logLevelLabel: lvlLabel,
        append: d.append,
        renderedText: formatted.renderedText,
        formatSource: 'packet-inline',
        rawFormatText: d.text,
        args: [...d.args],
        warnings: formatted.warnings,
      };
      for (const w of formatted.warnings) {
        diagnostics.push({ severity: 'warning', code: 'terminal-format-warning', message: w });
      }
      summary = `[${lvlLabel}${d.append ? '+APPEND' : ''}] ${formatted.renderedText}`;
      break;
    }
    case 'ex-print-elf': {
      terminalEntry = interpretExPrintElf(d.stringAddress, d.options, d.rawArgBytes, rodataLookup, limits);
      for (const w of terminalEntry.warnings) {
        diagnostics.push({
          severity: terminalEntry.formatSource === 'unresolved-address' ? 'error' : 'warning',
          code: terminalEntry.addressStatus === 'null-address'
            ? 'null-string-address'
            : terminalEntry.formatSource === 'unresolved-address'
              ? 'unresolved-string-address'
              : 'terminal-format-warning',
          message: w,
        });
      }
      summary = `[${terminalEntry.logLevelLabel}${terminalEntry.append ? '+APPEND' : ''}] ${terminalEntry.renderedText}`;
      break;
    }
    case 'os-freertos': {
      apiDetails = explainFreeRtosOsEvent(bootGeneration, d, meta, rodataLookup);
      if (apiDetails.interpretation === 'unmapped-api') {
        diagnostics.push({
          severity: 'info',
          code: 'unmapped-freertos-api',
          message: apiDetails.missingReason ?? `未映射参数 FreeRTOS API ${d.apiName ?? d.apiId}`,
        });
        summary = `${d.apiName ?? `API#${d.apiId}`} (未映射参数, ${d.rawPayload.length} B)`;
      } else if (apiDetails.interpretation === 'param-mismatch') {
        diagnostics.push({
          severity: 'warning',
          code: 'os-param-mismatch',
          message: apiDetails.missingReason ?? `FreeRTOS API ${d.apiName ?? d.apiId} 参数不匹配`,
        });
        summary = `${d.apiName ?? `API#${d.apiId}`} (参数不匹配, ${d.rawPayload.length} B)`;
      } else {
        const paramPreview = apiDetails.params
          .map(p => {
            const valStr = p.resolvedLabel
              ? `${p.resolvedLabel}@${p.resolvedHex ?? p.rawHex}`
              : p.resolvedHex
                ? p.resolvedHex
                : p.kind === 'u32' && p.name.endsWith('Ptr')
                  ? p.rawHex
                  : String(p.rawValue);
            return `${p.name}=${valStr}${p.enumNote ? `(${p.enumNote})` : ''}`;
          })
          .join(', ');
        summary = `${d.apiName ?? `API#${d.apiId}`}(${paramPreview})`;
        for (const p of apiDetails.params) {
          if (p.kind === 'shrunk-id' && p.idResolution && p.idResolution !== 'resolved') {
            diagnostics.push({
              severity: 'warning',
              code: 'id-resolution-failed',
              message: `${d.apiName ?? `API#${d.apiId}`}.${p.name} shrunk=${p.rawValue} 不可解析 (${p.idResolution})`,
            });
          }
        }
      }
      break;
    }
    case 'end-call':
      summary = `END_CALL ${d.apiName ?? `evt=${d.apiEventId}`}${d.hasReturnValue ? ` -> ${d.returnValue} (${formatHex32(d.returnValue ?? 0)})` : ''}`;
      break;
    case 'module-event': {
      const prev = formatHexBytesPreview(d.rawPayload, limits?.maxRawPayloadPreviewBytes ?? 64);
      rawPayloadHex = prev.truncated ? `${prev.hex} …` : prev.hex;
      diagnostics.push({
        severity: 'info',
        code: 'unknown-module-event',
        message: `中间件模块事件 MODULE_${pkt.eventId} (offset=${d.moduleEventOffset}, ${d.rawPayload.length} B)，首版无专属模块描述`,
      });
      summary = `MODULE_${pkt.eventId} (offset=${d.moduleEventOffset}, ${d.rawPayload.length} B)`;
      break;
    }
    case 'user-event': {
      const prev = formatHexBytesPreview(d.rawPayload, limits?.maxRawPayloadPreviewBytes ?? 64);
      rawPayloadHex = prev.truncated ? `${prev.hex} …` : prev.hex;
      diagnostics.push({
        severity: 'info',
        code: 'user-event-untyped',
        message: `用户自定义事件 USER_${pkt.eventId} (${d.rawPayload.length} B)，仅保留原始载荷`,
      });
      summary = `USER_${pkt.eventId} (${d.rawPayload.length} B)`;
      break;
    }
    case 'unknown-explicit': {
      const prev = formatHexBytesPreview(d.rawPayload, limits?.maxRawPayloadPreviewBytes ?? 64);
      rawPayloadHex = prev.truncated ? `${prev.hex} …` : prev.hex;
      diagnostics.push({
        severity: 'warning',
        code: 'unknown-explicit-event',
        message: `未知显式长度事件 ID=${pkt.eventId} (${d.rawPayload.length} B)，未猜测字段语义`,
      });
      summary = `UNKNOWN_${pkt.eventId} (${d.rawPayload.length} B raw=${rawPayloadHex || '<empty>'})`;
      break;
    }
    case 'ex-unknown': {
      const prev = formatHexBytesPreview(d.rawPayload, limits?.maxRawPayloadPreviewBytes ?? 64);
      rawPayloadHex = prev.truncated ? `${prev.hex} …` : prev.hex;
      diagnostics.push({
        severity: 'warning',
        code: 'unknown-extended-event',
        message: `未知扩展事件 EX subId=${d.exId} (${d.rawPayload.length} B)，未猜测字段语义`,
      });
      summary = `EX_UNKNOWN_${d.exId} (${d.rawPayload.length} B)`;
      break;
    }
    default:
      summary = pkt.eventName;
      break;
  }

  return {
    eventKey: `b${bootGeneration}:s${pkt.segmentId}:p${pkt.packetIndexInSegment}@${pkt.streamByteOffset}`,
    bootGeneration,
    segmentId: pkt.segmentId,
    segmentReliability: pkt.segmentReliability,
    packetIndexInSegment: pkt.packetIndexInSegment,
    streamByteOffset: pkt.streamByteOffset,
    byteLength: pkt.byteLength,
    eventId: pkt.eventId,
    eventName: pkt.eventName,
    category: pkt.category,
    schemaReliability: pkt.schemaReliability,
    deltaTicks: pkt.deltaTicks,
    relTicks: pkt.segmentRelativeTicks,
    ...(pkt.absoluteTicks !== undefined ? { absTicks: pkt.absoluteTicks } : {}),
    ...(ns !== undefined ? { ns } : {}),
    ...(freq !== undefined ? { sysFreqHz: freq } : {}),
    timeAnchorStatus: pkt.timeAnchorStatus,
    timeDomain,
    timestampWrapped: pkt.timestampWrapped,
    contextKind,
    ...(contextKey ? { contextKey } : {}),
    ...(contextLabel ? { contextLabel } : {}),
    ...(contextLabelSource ? { contextLabelSource } : {}),
    ...(taskInstanceId ? { taskInstanceId } : {}),
    ...(tcbAddress !== undefined ? { tcbAddress } : {}),
    ...(irqId !== undefined ? { irqId } : {}),
    isrDepth,
    nestedIsr,
    summary,
    ...(apiDetails ? { apiDetails } : {}),
    ...(terminalEntry ? { terminalEntry } : {}),
    ...(resolvedReferences.length > 0 ? { resolvedReferences } : {}),
    ...(rawPayloadHex ? { rawPayloadHex } : {}),
    diagnostics,
  };
}
