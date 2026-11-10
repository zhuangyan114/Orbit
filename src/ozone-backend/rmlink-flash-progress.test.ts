import { describe, expect, it } from 'vitest';
import { createRMLinkFlashProgressReporter } from './rmlink-flash-progress';

const sectors = [0, 1, 2, 3, 4].map(number => ({
  number,
  address: 0x08000000 + number * 16384,
  size: number === 4 ? 65536 : 16384,
}));

describe('RMLink Flash progress', () => {
  it('logs retry, fallback and progress rollback once, including recovery first seen at completion', () => {
    const messages: string[] = [];
    const report = createRMLinkFlashProgressReporter(0x08000000, 131072, sectors, message => messages.push(message));
    const recovery = {
      ram_retries: 2, retry_address: 0x20010020, retry_attempt: 2, downgraded: true,
      requested_clock_hz: 8000000, active_clock_hz: 4000000, fallback_clock_hz: 4000000,
      sector_address: 0x08010000, sector_size: 65536, erase_operations: 6, elapsed_us: 1140000,
    };
    report({ phase: 'program', programmed_bytes: 81920 });
    report({ phase: 'erase', programmed_bytes: 65536, erased_pages: 5, probe_recovery: recovery });
    report({ phase: 'erase', programmed_bytes: 65536, erased_pages: 5, probe_recovery: recovery });
    report({ phase: 'complete', verified: true, probe_recovery: recovery });
    expect(messages.filter(message => message.startsWith('RAM 缓冲恢复已重试'))).toHaveLength(1);
    expect(messages).toContain('烧录恢复已降频 8.0 MHz → 4.0 MHz');
    expect(messages).toContain('恢复扇区 0x08010000 至 0x0801FFFF，重新擦除并从扇区起点写入');
    expect(messages).toContain('写入进度回退至 65536/131072 字节，正在恢复当前扇区');
    expect(messages).toContain('重新擦除中... 0x08010000 至 0x0801FFFF，已擦除 5/5 个扇区');
    expect(messages).toContain('恢复汇总，RAM 重传 2 次，实际擦除 6 次，用时 1.140s');
    const finalMessages: string[] = [];
    const finalReport = createRMLinkFlashProgressReporter(0x08000000, 131072, sectors, message => finalMessages.push(message));
    finalReport({ phase: 'complete', verified: true, probe_recovery: recovery });
    expect(finalMessages).toContain('烧录恢复已降频 8.0 MHz → 4.0 MHz');
  });

  it('shows live sector ranges and measured completion timings without duplicate snapshots', () => {
    const messages: string[] = [];
    const report = createRMLinkFlashProgressReporter(0x08000000, 131072, sectors, message => messages.push(message));
    report({ phase: 'erase', erased_pages: 0 });
    report({ phase: 'erase', erased_pages: 0 });
    report({ phase: 'program', erased_pages: 1, programmed_bytes: 0 });
    report({ phase: 'erase', erased_pages: 4, programmed_bytes: 65536 });
    report({ phase: 'verify_probe', programmed_bytes: 131072 });
    report({ phase: 'complete', verified: true, source: 'status' });
    expect(messages.some(message => message.startsWith('烧录完成'))).toBe(false);
    report({
      phase: 'complete', verified: true, source: 'result', backend: 'probe',
      probe_stage_us: { preflight: 5407, loader: 12132, erase: 1329473, program: 1495404, full_verify: 717199 },
      timings: { probe_upload_ms: 697.838, host_finalize_ms: 15.033, enhanced_total_ms: 4533.604 },
    });
    report({ phase: 'erase', erased_pages: 0 });
    expect(messages.filter(message => message === '擦除中... 0x08000000 至 0x08003FFF，已擦除 0/5 个扇区')).toHaveLength(1);
    expect(messages).toContain('擦除中... 0x08010000 至 0x0801FFFF，已擦除 4/5 个扇区');
    expect(messages).toContain('已擦除 0x08000000 至 0x0801FFFF，共 5 个扇区，用时 1.329s');
    expect(messages).toContain('已写入 0x08000000 至 0x0801FFFF，共 131072 字节，用时 1.495s');
    expect(messages).toContain('已校验 0x08000000 至 0x0801FFFF，131072 字节全部通过，用时 0.717s');
    expect(messages.at(-1)).toBe('烧录完成 0x08000000 至 0x0801FFFF，用时 4.534s（总计）');
  });

  it('retains partial failure details and never completes an unverified image', () => {
    const messages: string[] = [];
    const report = createRMLinkFlashProgressReporter(0x08000000, 131072, sectors, message => messages.push(message));
    report({ phase: 'complete', verified: false });
    report({ phase: 'failed', erased_pages: 2, programmed_bytes: 16384, probe_error_address: 0x08004000, error: 'FlashFailed', host_elapsed_ms: 1140 });
    report({ phase: 'complete', verified: true });
    expect(messages.at(-1)).toContain('烧录失败，已擦除 2/5 个扇区，已写入 16384/131072 字节，失败地址 0x08004000，用时 1.140s');
    expect(messages.some(message => message.startsWith('已校验') || message.startsWith('烧录完成'))).toBe(false);
  });

  it('keeps sparse jobs separate and accepts older results without fabricated timings', () => {
    const messages: string[] = [];
    const report = createRMLinkFlashProgressReporter(0x08010000, 65536, [sectors[4]], message => messages.push(message));
    report({ phase: 'complete', verified: true });
    expect(messages).toContain('已擦除 0x08010000 至 0x0801FFFF，共 1 个扇区');
    expect(messages.join('\n')).not.toMatch(/0x08000000|NaN|用时/);
  });
});
