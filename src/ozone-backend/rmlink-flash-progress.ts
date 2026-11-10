import type { FlashSector } from './cmsis-dap-flasher';

interface FlashProgress {
  phase?: string;
  source?: string;
  backend?: string;
  verified?: boolean;
  erased_pages?: number;
  programmed_bytes?: number;
  probe_received_bytes?: number;
  probe_verified_bytes?: number;
  probe_error_address?: number;
  erase_strategy?: string;
  error?: string;
  host_elapsed_ms?: number;
  probe_stage_us?: Record<string, number>;
  timings?: Record<string, number>;
  probe_recovery?: {
    ram_retries: number;
    retry_address: number;
    retry_attempt: number;
    downgraded: boolean;
    requested_clock_hz: number;
    active_clock_hz: number;
    fallback_clock_hz: number;
    sector_address: number;
    sector_size: number;
    erase_operations: number;
    elapsed_us: number;
  };
}

function address(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function duration(milliseconds: number | undefined): string {
  return milliseconds !== undefined && Number.isFinite(milliseconds)
    ? `，用时 ${(milliseconds / 1000).toFixed(3)}s`
    : '';
}

/** Formats cached service snapshots. Only the verified COMMIT result completes a job. */
export function createRMLinkFlashProgressReporter(
  start: number,
  size: number,
  sectors: FlashSector[],
  emit: (message: string) => void,
): (snapshot: Record<string, unknown>) => void {
  const range = `${address(start)} 至 ${address(start + size - 1)}`;
  let previousMessage = '';
  let finished = false;
  let reportedRetries = 0;
  let reportedFallback = false;
  let previousProgrammed = 0;
  emit(`准备烧录 ${range}，共 ${size} 字节、${sectors.length} 个扇区`);

  return snapshot => {
    if (finished) return;
    const progress = snapshot as FlashProgress;
    const erased = Math.min(sectors.length, Math.max(0, progress.erased_pages ?? 0));
    const programmed = Math.min(size, Math.max(0, progress.programmed_bytes ?? 0));
    const recovery = progress.probe_recovery;
    if (recovery && recovery.ram_retries > reportedRetries) {
      emit(`RAM 缓冲恢复已重试 ${recovery.ram_retries} 次，最近地址 ${address(recovery.retry_address)}，最近一段重试 ${recovery.retry_attempt}/2${duration(recovery.elapsed_us / 1000)}`);
      reportedRetries = recovery.ram_retries;
    }
    if (recovery?.downgraded && !reportedFallback) {
      emit(`烧录恢复已降频 ${(recovery.requested_clock_hz / 1000000).toFixed(1)} MHz → ${(recovery.fallback_clock_hz / 1000000).toFixed(1)} MHz`);
      if (recovery.sector_size) {
        emit(`恢复扇区 ${address(recovery.sector_address)} 至 ${address(recovery.sector_address + recovery.sector_size - 1)}，重新擦除并从扇区起点写入`);
      } else {
        emit('重新加载 RAM 烧录算法');
      }
      reportedFallback = true;
    }
    if (programmed < previousProgrammed) emit(`写入进度回退至 ${programmed}/${size} 字节，正在恢复当前扇区`);
    previousProgrammed = programmed;
    if (progress.phase === 'complete' && progress.verified === true && progress.source !== 'status') {
      finished = true;
      const stages = progress.probe_stage_us;
      const stageDuration = (name: string) => duration(stages?.[name] === undefined ? undefined : stages[name] / 1000);
      if (progress.backend === 'probe') emit(`已上传 ${size} 字节至 RMLink${duration(progress.timings?.probe_upload_ms)}`);
      if (stages?.preflight !== undefined) emit(`目标预检查完成${stageDuration('preflight')}`);
      if (stages?.loader !== undefined) emit(`烧录算法加载与初始化完成${stageDuration('loader')}`);
      emit(`已擦除 ${range}，共 ${sectors.length} 个扇区${stageDuration('erase')}`);
      emit(`已写入 ${range}，共 ${size} 字节${stageDuration('program')}`);
      emit(`已校验 ${range}，${size} 字节全部通过${stageDuration('full_verify')}`);
      if (recovery?.ram_retries) {
        emit(`恢复汇总，RAM 重传 ${recovery.ram_retries} 次，实际擦除 ${recovery.erase_operations} 次${duration(recovery.elapsed_us / 1000)}`);
      }
      if (progress.timings?.host_finalize_ms !== undefined) {
        emit(`主机收尾完成${duration(progress.timings.host_finalize_ms)}`);
      }
      emit(`烧录完成 ${range}${duration(progress.timings?.enhanced_total_ms ?? progress.host_elapsed_ms)}（总计）`);
      return;
    }
    if (progress.phase === 'failed' || progress.phase === 'cancelled') {
      finished = true;
      const fault = progress.probe_error_address ? `，失败地址 ${address(progress.probe_error_address)}` : '';
      emit(`烧录${progress.phase === 'cancelled' ? '已取消' : '失败'}，已擦除 ${erased}/${sectors.length} 个扇区，已写入 ${programmed}/${size} 字节${fault}${duration(progress.host_elapsed_ms)}${progress.error ? `，${progress.error}` : ''}`);
      return;
    }

    let message: string;
    switch (progress.phase) {
      case 'staging': message = `准备镜像中... ${range}`; break;
      case 'staged': message = `镜像已提交至连接服务${duration(progress.host_elapsed_ms)}`; break;
      case 'upload_probe': {
        const percent = Math.floor((progress.probe_received_bytes ?? 0) * 10 / size) * 10;
        message = `上传至 RMLink 中... ${range}，${percent}%`;
        break;
      }
      case 'probe_ready': message = `RMLink 镜像缓存已就绪，共 ${size} 字节`; break;
      case 'preflight': message = '目标预检查中...'; break;
      case 'load_algorithm': message = '烧录算法加载与初始化中...'; break;
      case 'erase': {
        const recovering = recovery?.downgraded && recovery.sector_size > 0
          && programmed === recovery.sector_address - start;
        const sector = recovering ? sectors.find(sector => sector.address === recovery.sector_address)
          : progress.erase_strategy === 'mass' ? undefined : sectors[erased];
        const current = sector ? `${address(sector.address)} 至 ${address(sector.address + sector.size - 1)}` : range;
        message = `${recovering ? '重新擦除中' : '擦除中'}... ${current}，已擦除 ${erased}/${sectors.length} 个扇区`;
        break;
      }
      case 'program':
      case 'verify_page': {
        const percent = Math.floor(programmed * 10 / size) * 10;
        message = `写入中... ${range}，${percent}%`;
        break;
      }
      case 'verify':
      case 'verify_probe': message = `全镜像校验中... ${range}`; break;
      case 'verify_host': message = `主机独立校验中... ${range}`; break;
      case 'reset':
      case 'probe_complete': message = '烧录收尾中...'; break;
      case 'progress_unavailable': message = `进度查询失败，等待烧录请求返回，${progress.error}`; break;
      default: return;
    }
    if (message !== previousMessage) emit(message);
    previousMessage = message;
  };
}
