import { describe, expect, it } from 'vitest';
import { decodeSystemViewStream } from './systemview-decoder';
import {
  buildEmptyMetadataContext,
  formatSystemViewPrintFormatted,
  formatTraceEventDto,
  interpretExPrintElf,
  type VerifiedElfRodataLookup,
} from './systemview-formatter';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';

describe('SystemView 有限词法格式化与 FreeRTOS 参数解释 (阶段 5.2)', () => {
  it('严格按有限词法解释有参 printf，并无损保留零参数目标已格式化文本', () => {
    const signedHex = formatSystemViewPrintFormatted('count=%d code=%x', [4294967289, 42]);
    expect(signedHex.renderedText).toBe('count=-7 code=2a');
    expect(signedHex.warnings).toEqual([]);

    const padded = formatSystemViewPrintFormatted('%08X %+05d %% %u', [0xabc, 7, 123]);
    expect(padded.renderedText).toBe('00000ABC +0007 % 123');
    expect(padded.warnings).toEqual([]);

    // 目标侧已格式化（numArgs === 0）：含 %d/%x/%%/孤立% 均无损保留字面字符
    const targetFormatted = formatSystemViewPrintFormatted('literal=%d %x %%', []);
    expect(targetFormatted.renderedText).toBe('literal=%d %x %%');
    expect(targetFormatted.warnings).toEqual([]);

    const trailingPct = formatSystemViewPrintFormatted('literal=<sample> %', []);
    expect(trailingPct.renderedText).toBe('literal=<sample> %');
    expect(trailingPct.warnings).toEqual([]);
  });

  it('拦截 %n、拒绝解引用 %s、钳制超大宽度并转义终端控制符', () => {
    const blocked = formatSystemViewPrintFormatted('evil=%n ptr=%s width=%9999999d lit=${1+1}', [0x20001000, 0x20002000, 5]);
    expect(blocked.renderedText).toContain('<%n:blocked>');
    expect(blocked.renderedText).toContain('<str@0x20002000:不可解析指针>');
    expect(blocked.renderedText).toContain('lit=${1+1}');
    expect(blocked.renderedText.length).toBeLessThan(256);
    expect(blocked.warnings.some(w => w.includes('%n'))).toBe(true);
    expect(blocked.warnings.some(w => w.includes('%s'))).toBe(true);
    expect(blocked.warnings.some(w => w.includes('宽度'))).toBe(true);

    const ansiEscape = formatSystemViewPrintFormatted('hi\x1b[31mred\r\nline2', []);
    expect(ansiEscape.renderedText).toBe('hi\\x1b[31mred\nline2');
    expect(ansiEscape.warnings.some(w => w.includes('控制字符'))).toBe(true);
  });

  it('明确区分 EX_PRINT_ELF 的 NULL 地址、无 ELF、SHA 不匹配、越界异常地址与已验证只读段', () => {
    const argBytes = new Uint8Array([0xb4, 0x24]); // varint(0x1234) = 4660
    const nullRes = interpretExPrintElf(0, 2, argBytes);
    expect(nullRes.addressStatus).toBe('null-address');
    expect(nullRes.formatSource).toBe('unresolved-address');
    expect(nullRes.warnings.some(w => w.includes('NULL'))).toBe(true);

    const noElfRes = interpretExPrintElf(0x0801fff0, 2, argBytes);
    expect(noElfRes.addressStatus).toBe('no-elf-loaded');
    expect(noElfRes.formatSource).toBe('unresolved-address');
    expect(noElfRes.args).toEqual([0x1234]);
    expect(noElfRes.renderedText).toContain('0x0801FFF0');

    const mismatchLookup: VerifiedElfRodataLookup = {
      elfSha256: 'aaa',
      expectedSha256: 'bbb',
      lookupCString: () => ({ status: 'resolved', text: 'bad=%u' }),
    };
    expect(interpretExPrintElf(0x08001000, 0, argBytes, mismatchLookup).addressStatus).toBe('elf-sha-mismatch');

    const validLookup: VerifiedElfRodataLookup = {
      elfSha256: 'same',
      expectedSha256: 'same',
      lookupCString: (addr) => (addr === 0x08001000 ? { status: 'resolved', text: 'elf_val=0x%x' } : { status: 'outside-rodata' }),
    };
    const okElf = interpretExPrintElf(0x08001000, 0, argBytes, validLookup);
    expect(okElf.formatSource).toBe('elf-rodata');
    expect(okElf.renderedText).toBe('elf_val=0x1234');

    const outsideElf = interpretExPrintElf(0xdeadbeef, 2, argBytes, validLookup);
    expect(outsideElf.addressStatus).toBe('outside-rodata');
    expect(outsideElf.formatSource).toBe('unresolved-address');
  });

  it('详细解释 FreeRTOS API 参数、枚举与不可解析 ID 状态', () => {
    const meta = buildEmptyMetadataContext();
    (meta.resourceNamesByBoot as Map<number, Map<number, string>>).set(1, new Map([[0x20000200, 'sensorQueue']]));
    const dto = formatTraceEventDto({
      bootGeneration: 1,
      meta,
      pkt: {
        protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
        segmentId: 1,
        packetIndexInSegment: 23,
        streamByteOffset: 182,
        byteLength: 11,
        eventId: 32 + 58,
        eventName: 'OS_xQueueGenericSend',
        category: 'os-freertos',
        schemaReliability: 'known',
        segmentReliability: 'trusted',
        deltaTicks: 1,
        segmentRelativeTicks: '77',
        segmentRelativeTicksBigInt: 77n,
        absoluteTicks: '177',
        absoluteTicksBigInt: 177n,
        timestampWrapped: false,
        timeAnchorStatus: 'anchored-cycles',
        sysFreqHz: 1_000_000,
        decoded: {
          kind: 'os-freertos',
          apiId: 58,
          apiName: 'xQueueGenericSend',
          interpretation: 'matched',
          rawPayload: new Uint8Array([0x80, 0x01]),
          params: [
            { name: 'queueId', kind: 'shrunk-id', rawValue: 128, resolvedId: 0x20000200, idResolution: 'resolved' },
            { name: 'itemPtr', kind: 'u32', rawValue: 0x20000320 },
            { name: 'ticksToWait', kind: 'u32', rawValue: 0xffffffff },
            { name: 'copyPosition', kind: 'u32', rawValue: 2 },
          ],
        },
      },
    });
    expect(dto.apiDetails?.apiName).toBe('xQueueGenericSend');
    expect(dto.apiDetails?.params[0].resolvedLabel).toBe('sensorQueue');
    expect(dto.apiDetails?.params[0].resolvedLabelSource).toBe('name-resource');
    expect(dto.apiDetails?.params[2].enumNote).toContain('portMAX_DELAY');
    expect(dto.apiDetails?.params[3].enumNote).toBe('queueOVERWRITE');

    // 未解码出地址的 shrunk-id 不可猜地址并产生诊断
    const unresolvedDto = formatTraceEventDto({
      bootGeneration: 1,
      meta,
      pkt: {
        protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
        segmentId: 0,
        packetIndexInSegment: 1,
        streamByteOffset: 10,
        byteLength: 4,
        eventId: 32 + 9,
        eventName: 'OS_vTaskSuspend',
        category: 'os-freertos',
        schemaReliability: 'known',
        segmentReliability: 'uncertain',
        deltaTicks: 0,
        segmentRelativeTicks: '0',
        segmentRelativeTicksBigInt: 0n,
        timestampWrapped: false,
        timeAnchorStatus: 'unanchored',
        decoded: {
          kind: 'os-freertos',
          apiId: 9,
          apiName: 'vTaskSuspend',
          interpretation: 'matched',
          rawPayload: new Uint8Array([5]),
          params: [{ name: 'taskId', kind: 'shrunk-id', rawValue: 5, idResolution: 'unresolved-missing-init' }],
        },
      },
    });
    expect(unresolvedDto.timeDomain).toBe('unknown');
    expect(unresolvedDto.diagnostics.some(d => d.code === 'id-resolution-failed')).toBe(true);
    expect(unresolvedDto.diagnostics.some(d => d.code === 'uncertain-segment')).toBe(true);
  });

  it('保留未知显式事件原始载荷且不猜测字段，兼容解码器输出', () => {
    const sync = new Uint8Array(10);
    // ID=30 (unknown explicit), len=3, payload=[0xaa,0xbb,0xcc], delta=5
    const pktBytes = new Uint8Array([...sync, 30, 3, 0xaa, 0xbb, 0xcc, 5]);
    const decoded = decodeSystemViewStream(pktBytes, { initialSyncMode: 'synced' });
    const unknownPkt = decoded.packets.find(p => p.eventId === 30);
    expect(unknownPkt).toBeDefined();
    const dto = formatTraceEventDto({
      pkt: unknownPkt!,
      bootGeneration: 1,
      meta: buildEmptyMetadataContext(),
    });
    expect(dto.schemaReliability).toBe('unknown-explicit');
    expect(dto.rawPayloadHex).toBe('aa bb cc');
    expect(dto.diagnostics.some(d => d.code === 'unknown-explicit-event')).toBe(true);
  });
});
