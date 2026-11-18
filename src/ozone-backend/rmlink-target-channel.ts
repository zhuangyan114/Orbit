/** Experimental RMLink owner. Uses the public SDK; target execution stays in Connector.
 * SDK source in clients/rmlink is vendored from @rmlink/client 0.2.8 (Apache-2.0).
 */
import { RMLinkClient, CaptureSample, SubscriptionConfig } from '../../clients/rmlink/rmlink-client.mjs';
import type { SessionTargetOwner, SessionTargetConnectConfig, TargetChannelInfo } from './session-target-channel';
import type { CppJLinkResult, NativeStepIntoDiagnostics, NativeStepIntoSourceLineRequest, NativeStepOverDiagnostics, NativeStepOverRequest, NativeStepOutDiagnostics } from './cpp-jlink-channel';
import { NativeScheduler, NativeSchedulerCancelledError, NativeScheduleOptions } from './native-scheduler';
import type { CppJLinkReadOptions } from './cpp-jlink-channel';
import { log } from '../utils/logger';
import {readFile} from 'node:fs/promises';
import {parseElf32LoadSegments,calculateEraseSectors,coalesceFlashProgramRanges,resolveFlashTarget,CmsisDapFlashOptions,CmsisDapFlashResult,FlashTargetDefinition} from './cmsis-dap-flasher';
import { CmsisDapRttEnumOptions, CmsisDapRttEnumResult, CmsisDapRttMemoryRange, CmsisDapRttStartOptions, CmsisDapRttWriteOptions, CmsisDapRttWriteResult, CmsisDapRunToAddressResult } from './cmsis-dap-helper-channel';
import { isValidRttEnumResult, isValidRttWriteResult, RttCapabilities, rttCapability, unavailableRttCapabilities, validateRttMemoryRanges } from './rtt-contract';
import { createRMLinkFlashProgressReporter } from './rmlink-flash-progress';
import { SeggerRttMemoryEngine } from './segger-rtt-memory';

export class RMLinkTargetChannel implements SessionTargetOwner {
  readonly kind = 'cmsis-dap' as const;
  readonly supportsSubscriptions = true;
  flashTarget:FlashTargetDefinition|null=null;
  private readonly client: RMLinkClient;
  private readonly scheduler = new NativeScheduler();
  private connected = false;
  private readonly breakpoints = new Set<number>();
  private streamAbort: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private readonly listeners = new Set<(sample: CaptureSample) => void>();
  private readonly streamLostListeners = new Set<()=>void>();
  private readonly rttData = new Map<number, Buffer>();
  private readonly rttIds = new Set<number>();
  private readonly activeCaptures=new Map<number,number>();
  private rttCacheDropped=0;
  private rttControlBlockAddress:number|undefined;
  private rttCustomRamRanges:readonly CmsisDapRttMemoryRange[]|undefined;
  private rttMemoryOnly=false;
  private readonly rttMemoryEngine: SeggerRttMemoryEngine;
  private rttWriteChain: Promise<unknown> = Promise.resolve();
  private flashing=false;
  constructor(client = new RMLinkClient()) {
    this.client = client;
    this.rttMemoryEngine = new SeggerRttMemoryEngine({
      read: (address, size, priority, signal) => this.readMemoryWithPriority(address, size, priority, signal),
      write: (address, bytes, priority) => this.writeMemoryWithPriority(address, bytes, priority),
    }, { maxChunkBytes: 128, writeAlignmentBytes: 4 });
  }
  get usingNative() { return this.connected; }
  async connect(config: SessionTargetConnectConfig): Promise<CppJLinkResult<TargetChannelInfo>> {
    if (config.interface && config.interface!=='SWD') return this.failure('RMLink currently requires interface: SWD','InvalidConfiguration');
    try {
      const status=await this.client.init() as {devices?:Array<{device_id:string;paired:boolean;connected:boolean}>};
      let deviceId=config.rmlinkDeviceId;
      if(!deviceId){
        const candidates=(status?.devices || []).filter(d=>d.paired && d.connected);
        if(candidates.length!==1)return this.failure(
          candidates.length?'Multiple RMLink devices are online; set rmlinkDeviceId.':'No paired RMLink device is online. Start the RMLink connection service and check the hotspot.',
          candidates.length?'AmbiguousDevice':'DeviceNotFound');
        deviceId=candidates[0].device_id;
      }
      const target=resolveFlashTarget(config.device);
      await this.client.open(deviceId);
      await this.client.target('connect',{clock_hz: config.speedKHz ? config.speedKHz*1000 : 4000000,device:target.name});
      this.connected = true;
      this.flashTarget=target;
      return this.success({channel:'cmsis-dap',diagnostics:{transport:'rmlink-service',deviceId,subscriptions:true}});
    } catch (error) {
      await this.client.close().catch(()=>{});
      const code=(error as {errorCode?:string;code?:string}).errorCode || (error as {code?:string}).code;
      return this.failure(code==='TargetBusy'
        ? 'RMLink 目标正被另一个调试会话占用，请结束那个会话后重试。当前未执行烧录。'
        : String(error),code || 'RMLinkConnectFailed');
    }
  }
  private success<T>(data:T):CppJLinkResult<T> { return {ok:true,message:'RMLink',targetState:this.connected?'Unknown':'Disconnected',elapsedMs:0,data}; }
  private failure<T>(message:string,errorCode='UnsupportedCapability'):CppJLinkResult<T> { return {ok:false,message,errorCode,targetState:'Error',elapsedMs:0}; }
  private async control<T>(command:string,params:Record<string,unknown>={},options:NativeScheduleOptions={priority:'control'}):Promise<CppJLinkResult<T>> {
    if(!this.connected) return this.failure('RMLink owner unavailable','NativeOwnerLost');
    try { return await this.scheduler.schedule(async()=>{
      if(options.signal?.aborted)return this.failure('RMLink read cancelled','TargetReadCancelled');
      const data=await this.client.target<T>(command,params);
      if(options.signal?.aborted)return this.failure('RMLink read cancelled','TargetReadCancelled');
      const state=data && typeof data==='object' ? (data as {state?:unknown;dhcsr?:unknown}) : {};
      const result=this.success(data);
      if(state.state==='Halted' || state.state==='Running')result.targetState=state.state;
      else if(typeof state.dhcsr==='number')result.targetState=state.dhcsr&0x20000?'Halted':'Running';
      return result;
    },options); }
    catch(error) {
      if(error instanceof NativeSchedulerCancelledError)return this.failure(String(error),'TargetReadCancelled');
      const response=error as {httpStatus?:number;errorCode?:string};
      log.dll(`[rmlink] request failed command=${command} status=${response.httpStatus ?? 'transport'} code=${response.errorCode ?? 'unknown'} error=${String(error)}`);
      if(response.httpStatus && response.httpStatus<500)return this.failure(String(error),response.errorCode || 'RMLinkRequestFailed');
      this.connected=false;return this.failure(String(error),'NativeOwnerLost');
    }
  }
  halt() { return this.control('halt'); }
  run() { return this.control('run'); }
  step() { return this.control('step'); }
  reset() { return this.control('reset'); }
  runToAddress(address:number,reset:boolean) { return this.control<CmsisDapRunToAddressResult>('run_to_address',{address,reset}); }
  getState() { return this.control<{state:string}>('state'); }
  readRegister(index:number) { return this.control<{value:number}>('read_register',{index}); }
  async readMemory(address:number,size:number,options:CppJLinkReadOptions={}):Promise<CppJLinkResult<{bytes:Uint8Array}>> {
    return this.readMemoryWithPriority(address, size, options.priority || 'watch', options.signal);
  }
  private async readMemoryWithPriority(address:number,size:number,priority:'watch'|'timeline'|'background'|'control',signal?:AbortSignal):Promise<CppJLinkResult<{bytes:Uint8Array}>> {
    const r=await this.control<{data:string}>('read_memory',{address,byte_length:size},{priority,signal});
    return r.ok && r.data?{...r,data:{bytes:Buffer.from(r.data.data,'hex')}}:this.failure(r.message,r.errorCode);
  }
  async readMemoryBatch(reads:Array<{address:number;size:number}>,options:CppJLinkReadOptions={}):Promise<CppJLinkResult<{reads:Array<{address:number;bytes:Uint8Array}>}>> {
    const r=await this.control<{reads:Array<{address:number;data:string}>}>('read_batch',{reads:reads.map(r=>({address:r.address,byte_length:r.size}))},{...options,priority:options.priority || 'watch'});
    return r.ok && r.data?{...r,data:{reads:r.data.reads.map(v=>({address:v.address,bytes:Buffer.from(v.data,'hex')}))}}:this.failure(r.message,r.errorCode);
  }
  async writeMemory(address:number,bytes:Uint8Array):Promise<CppJLinkResult<{address:number;bytesWritten:number}>> {
    return this.writeMemoryWithPriority(address, bytes, 'control');
  }
  private async writeMemoryWithPriority(address:number,bytes:Uint8Array,priority:'control'|'background'):Promise<CppJLinkResult<{address:number;bytesWritten:number}>> {
    if (!Number.isInteger(address) || address < 0 || (address % 4) !== 0
      || bytes.length === 0 || (bytes.length % 4) !== 0 || bytes.length > 4096
      || address + bytes.length > 0x100000000) {
      return this.failure('RMLink write_memory requires 4-byte aligned uint32 address and non-zero 4-byte aligned length <= 4096', 'UnsupportedCapability');
    }
    const r=await this.control<{bytes_written:number}>('write_memory',{address,data:Buffer.from(bytes).toString('hex')},{priority});
    return r.ok && r.data?{...r,data:{address,bytesWritten:r.data.bytes_written}}:this.failure(r.message,r.errorCode);
  }
  async setBreakpoint(address:number) {
    const r=await this.control<{id:number}>('set_breakpoint',{address});if(r.ok && r.data)this.breakpoints.add(r.data.id);return r;
  }
  async clearBreakpoint(id:number) { const r=await this.control('clear_breakpoint',{id});if(r.ok)this.breakpoints.delete(id);return r; }
  async clearAllBreakpoints() { for(const id of this.breakpoints){const r=await this.clearBreakpoint(id);if(!r.ok)return r;}return this.success({}); }
  async subscribe(kind:'memory_series'|'memory_snapshot'|'rtt_stream',config:SubscriptionConfig) {
    return this.scheduler.schedule(()=>this.subscribeSerial(kind,config),{priority:'control'});
  }
  private async subscribeSerial(kind:'memory_series'|'memory_snapshot'|'rtt_stream',config:SubscriptionConfig) {
    if(!this.connected)throw new Error('RMLink owner unavailable');
    if(this.flashing)throw new Error('Flash operation owns the target');
    const r=await this.client.subscribe(kind,config);
    this.activeCaptures.set(r.subscription_id,r.capture_id);
    log.dll(`[rmlink] subscribed kind=${kind} subscription=${r.subscription_id} capture=${r.capture_id}`);
    if(!this.streamTask) {
      const abort=new AbortController();this.streamAbort=abort;
      // Store the task before entering the reader, including a reader that
      // throws immediately. Completed data readers must not block a later
      // explicit subscription from reopening the stream on the same owner.
      this.streamTask=Promise.resolve().then(async()=>{
        log.dll(`[rmlink] capture stream opened subscriptions=${JSON.stringify([...this.activeCaptures])}`);
        try { for await(const record of this.client.stream({signal:abort.signal})) {
          const sample=record.sample;
          if(this.activeCaptures.get(sample.subscriptionId)!==sample.captureId)continue;
          if(sample.kind===3 && sample.data) {
            const channel=sample.channel || 0, previous=this.rttData.get(channel) || Buffer.alloc(0);
            const combined=Buffer.concat([previous,Buffer.from(sample.data)]);
            this.rttCacheDropped+=Math.max(0,combined.length-65536);
            this.rttData.set(channel,combined.subarray(-65536));
          }
          for(const listener of this.listeners) {
            try{listener(sample);}catch{this.listeners.delete(listener);}
          }
        }
          if(!abort.signal.aborted)log.dll('[rmlink] capture stream ended; control owner retained');
        } catch(error) {
          if(!abort.signal.aborted)log.dll(`[rmlink] capture stream lost: ${String(error)}; control owner retained`);
        } finally {
          // Control/heartbeat requests establish whether the owner was lost.
          // EOF on this independent data stream alone cannot decide that.
          if(this.streamAbort===abort){
            this.streamTask=null;this.streamAbort=null;
            if(!abort.signal.aborted && this.connected && !this.flashing) {
              for(const listener of this.streamLostListeners) {
                try{listener();}catch{this.streamLostListeners.delete(listener);}
              }
            }
          }
        }
      });
    }
    return r;
  }
  onCapture(listener:(sample:CaptureSample)=>void) { this.listeners.add(listener);return ()=>this.listeners.delete(listener); }
  onCaptureStreamLost(listener:()=>void) { this.streamLostListeners.add(listener);return ()=>this.streamLostListeners.delete(listener); }
  async unsubscribe(id:number) {
    await this.scheduler.schedule(async()=>{
      await this.client.unsubscribe(id);this.activeCaptures.delete(id);
      if(!this.activeCaptures.size)await this.stopCaptureStream();
    },{priority:'control'});
  }
  private async stopCaptureStream() {
    const task=this.streamTask,abort=this.streamAbort;abort?.abort();
    if(task)await task;
    if(this.streamAbort===abort){this.streamTask=null;this.streamAbort=null;}
  }
  getRttCapabilities(): RttCapabilities {
    if (!this.connected) {
      return unavailableRttCapabilities(this.kind, 'RMLink target owner is not connected');
    }
    return {
      ownerKind: this.kind,
      rttStart: rttCapability(true),
      rttEnumerate: rttCapability(true),
      rttUpRead: rttCapability(true),
      rttDownWrite: rttCapability(true),
      details: {
        transport: 'rmlink-service',
        subscriptions: true,
        registeredTarget: Boolean(this.flashTarget),
        requiresExplicitRamRanges: !this.flashTarget,
        writeMemoryAlignmentBytes: 4,
        rttDownWriteMode: 'aligned-word-rmw-within-down-buffer',
      },
    };
  }
  private resolveRttRamRanges(explicit?: readonly CmsisDapRttMemoryRange[], label = 'ramRanges'):
    { ok: true; ranges: CmsisDapRttMemoryRange[] } | { ok: false; result: CppJLinkResult<any> } {
    if (explicit !== undefined) {
      const checked = validateRttMemoryRanges(explicit, false, label);
      if (!checked.ok) return { ok: false, result: this.failure(checked.message, 'DapInvalidRequest') };
      return { ok: true, ranges: checked.normalized };
    }
    if (this.flashTarget) {
      return { ok: true, ranges: this.flashTarget.ramRegions.map(r => ({ address: r.address, size: r.size })) };
    }
    return {
      ok: false,
      result: this.failure('RMLink RTT requires a registered target or explicit ramRanges', 'UnsupportedCapability'),
    };
  }
  async startRtt(controlBlockAddress?:number,options?:CmsisDapRttStartOptions) {
    if(controlBlockAddress===undefined)return this.failure('RTT control block address required','InvalidConfiguration');
    if(!Number.isInteger(controlBlockAddress) || controlBlockAddress<=0 || controlBlockAddress>0xFFFFFFFF) {
      return this.failure('RTT control block address must be a positive uint32','DapInvalidRequest');
    }
    if(options?.ramRanges!==undefined) {
      const checked=validateRttMemoryRanges(options.ramRanges,false,'ramRanges');
      if(!checked.ok)return this.failure(checked.message,'DapInvalidRequest');
      this.rttCustomRamRanges=checked.normalized;
    } else {
      this.rttCustomRamRanges=undefined;
    }
    this.rttControlBlockAddress=controlBlockAddress>>>0;
    if(options?.memoryBacked) {
      const resolved=this.resolveRttRamRanges(this.rttCustomRamRanges);
      if(!resolved.ok)return resolved.result;
      const started=await this.rttMemoryEngine.start(this.rttControlBlockAddress,resolved.ranges);
      if(!started.ok)return started;
      this.rttMemoryOnly=true;
      return this.success({controlBlockAddress:this.rttControlBlockAddress,memoryBacked:true});
    }
    this.rttMemoryOnly=false;
    try {const r=await this.subscribe('rtt_stream',{control_block_address:this.rttControlBlockAddress});this.rttIds.add(r.subscription_id);return this.success({});}
    catch(error){return this.failure(String(error),'RMLinkRttFailed');}
  }
  async enumerateRtt(controlBlockAddress?:number,options?:CmsisDapRttEnumOptions):Promise<CppJLinkResult<CmsisDapRttEnumResult>> {
    if(!this.connected)return this.failure('RMLink owner unavailable','NativeOwnerLost');
    let cbAddr:number;
    if(controlBlockAddress!==undefined) {
      if(!Number.isInteger(controlBlockAddress) || controlBlockAddress<=0 || controlBlockAddress>0xFFFFFFFF) {
        return this.failure('RMLink enumerateRtt controlBlockAddress must be a positive uint32','DapInvalidRequest');
      }
      cbAddr=controlBlockAddress>>>0;
    } else if(this.rttControlBlockAddress!==undefined) {
      cbAddr=this.rttControlBlockAddress;
    } else {
      return this.failure('RMLink enumerateRtt requires controlBlockAddress when RTT is not started','RttInvalidControlBlock');
    }
    const ram=this.resolveRttRamRanges(options?.ramRanges??this.rttCustomRamRanges);
    if(!ram.ok)return ram.result;
    let roRanges:CmsisDapRttMemoryRange[]=[];
    if(options?.roRanges!==undefined) {
      const roChecked=validateRttMemoryRanges(options.roRanges,true,'roRanges');
      if(!roChecked.ok)return this.failure(roChecked.message,'DapInvalidRequest');
      roRanges=roChecked.normalized;
    } else if(this.flashTarget) {
      roRanges=[{address:this.flashTarget.flashBase,size:this.flashTarget.flashSize}];
    }
    const timeoutMs=options?.timeoutMs??2000;
    const res=await this.rttMemoryEngine.enumerate(cbAddr,ram.ranges,roRanges,timeoutMs);
    if(res.ok && res.data && !isValidRttEnumResult(res.data)) {
      return this.failure('RMLink enumerateRtt returned a malformed result','MalformedResponse');
    }
    return res;
  }
  async stopRtt() {
    for(const id of this.rttIds)await this.unsubscribe(id);
    this.rttIds.clear();this.rttData.clear();
    this.rttMemoryEngine.stop();this.rttMemoryOnly=false;
    return this.success({});
  }
  async readRtt(channel:number,size:number,options?:CppJLinkReadOptions) {
    if(!this.connected)return this.failure<{bytes:Uint8Array}>('RMLink owner unavailable','NativeOwnerLost');
    if(channel===0 && !this.rttMemoryOnly && this.rttIds.size>0) {
      const data=this.rttData.get(channel)||Buffer.alloc(0);
      const bytes=data.subarray(0,size);
      this.rttData.set(channel,data.subarray(bytes.length));
      const res=this.success({bytes,bufferIndex:0,requestedBytes:size,readBytes:bytes.length,committedBytes:bytes.length});
      res.diagnostics={transport:'rmlink-rtt-stream',cacheDroppedBytes:this.rttCacheDropped};
      return res;
    }
    if(!this.rttMemoryEngine.isStarted) {
      if(this.rttControlBlockAddress===undefined)return this.failure<{bytes:Uint8Array}>('RTT is not started','RttStopped');
      const ram=this.resolveRttRamRanges(this.rttCustomRamRanges);
      if(!ram.ok)return ram.result;
      const started=await this.rttMemoryEngine.start(this.rttControlBlockAddress,ram.ranges);
      if(!started.ok)return started as unknown as CppJLinkResult<{bytes:Uint8Array}>;
    }
    return this.rttMemoryEngine.readUp(channel,size,options?.signal);
  }
  async writeRtt(bufferIndex:number,bytes:Uint8Array,options?:CmsisDapRttWriteOptions):Promise<CppJLinkResult<CmsisDapRttWriteResult>> {
    if(!this.connected)return this.failure<CmsisDapRttWriteResult>('RMLink owner unavailable','NativeOwnerLost');
    let cbAddr:number;
    if(options?.controlBlockAddress!==undefined) {
      if(!Number.isInteger(options.controlBlockAddress) || options.controlBlockAddress<=0 || options.controlBlockAddress>0xFFFFFFFF) {
        return this.failure('RMLink RTT control block address must be a positive uint32','DapInvalidRequest');
      }
      cbAddr=options.controlBlockAddress>>>0;
    } else if(this.rttControlBlockAddress!==undefined) {
      cbAddr=this.rttControlBlockAddress;
    } else {
      return this.failure('RMLink writeRtt requires controlBlockAddress when RTT is not started','RttInvalidControlBlock');
    }
    const ram=this.resolveRttRamRanges(options?.ramRanges??this.rttCustomRamRanges);
    if(!ram.ok)return ram.result;
    const timeoutMs=options?.timeoutMs??2000;
    const run = this.rttWriteChain.then(async () => {
      if (!this.connected) return this.failure<CmsisDapRttWriteResult>('RMLink owner unavailable', 'NativeOwnerLost');
      const res = await this.rttMemoryEngine.writeDown(cbAddr, ram.ranges, bufferIndex, bytes, timeoutMs);
      if (res.ok && res.data && !isValidRttWriteResult(res.data, bytes.length, bufferIndex)) {
        return this.failure<CmsisDapRttWriteResult>('RMLink writeRtt returned a malformed result', 'MalformedResponse');
      }
      return res;
    });
    this.rttWriteChain = run.then(() => undefined, () => undefined);
    return run;
  }
  async flash(elfPath:string,device:string,options:CmsisDapFlashOptions={}):Promise<CppJLinkResult<CmsisDapFlashResult>> {
    if(!this.connected)return this.failure('RMLink owner unavailable','NativeOwnerLost');
    if(this.flashing)return this.failure('Flash operation already running','RequestBusy');
    this.flashing=true;
    try {
      const target=resolveFlashTarget(device);
      if(this.flashTarget?.name!==target.name)return this.failure('Flash target differs from the connected shared-package target','TargetMismatch');
      if(options.signal?.aborted)return this.failure('Flash cancelled','RequestCancelled');
      const segments=parseElf32LoadSegments(await readFile(elfPath));
      const sectors=calculateEraseSectors(segments,target);
      const ranges=coalesceFlashProgramRanges(segments,target);
      if(!sectors.length)return this.failure('ELF has no supported Flash load bytes','InvalidConfiguration');
      const groups:Array<{address:number;size:number}>=[];
      for(const sector of sectors) {
        const previous=groups[groups.length-1];
        if(previous && previous.address+previous.size===sector.address)previous.size+=sector.size;
        else groups.push({address:sector.address,size:sector.size});
      }
      const images=groups.map(group=>{
        const image=Buffer.alloc(group.size,0xff);
        for(const range of ranges) {
          const first=Math.max(group.address,range.address),last=Math.min(group.address+group.size,range.address+range.bytes.length);
          if(first<last)image.set(range.bytes.subarray(first-range.address,last-range.address),first-group.address);
        }
        return {...group,image};
      });
      const result=await this.scheduler.schedule(async()=>{
        try {
          const jobs:Array<Record<string,unknown>>=[];
          for(let i=0;i<images.length;i++) {
            const group=images[i];
            const reportProgress=createRMLinkFlashProgressReporter(group.address,group.size,
              sectors.filter(sector=>sector.address>=group.address && sector.address<group.address+group.size),
              message=>{
                log.dll(`[cmsis-dap] [rmlink] ${message}`);
                try {options.onProgress?.(message);} catch {}
              });
            const job=await this.client.flashImage(group.image,group.address,options.signal,{
              resetAfter:i===images.length-1,timeoutMs:660000,onProgress:reportProgress,
            });
            if(job.verified!==true)throw new Error('Flash did not report a complete image verification');
            reportProgress({...job,phase:'complete'});
            jobs.push(job);
          }
          return {...jobs[jobs.length-1],verified:true,jobs};
        }
        finally {
          // COMMIT stops board subscriptions. End the corresponding local
          // generation too, so subscriptions after Flash open a fresh stream.
          for(const id of this.activeCaptures.keys())await this.client.unsubscribe(id).catch(()=>{});
          await this.stopCaptureStream();this.activeCaptures.clear();
          this.rttIds.clear();this.rttData.clear();
          this.rttMemoryEngine.stop();this.rttMemoryOnly=false;
        }
      },{priority:'control'});
        if(result.verified!==true)throw new Error('Flash did not report a complete image verification');
        this.breakpoints.clear();this.rttIds.clear();this.rttData.clear();
        this.activeCaptures.clear();
        return this.success({success:true,message:'RMLink service programmed and fully verified the image',
          reports:[],erasedSectors:sectors,target,diagnostics:result});
    }catch(error){
      const failure=error as {name?:string;errorCode?:string;code?:string;ownerLost?:boolean;httpStatus?:number;details?:{progress?:Record<string,unknown>}};
      if(failure.ownerLost)this.connected=false;
      const errorCode=failure.errorCode==='FlashCancelled' || failure.name==='AbortError'?'RequestCancelled':failure.ownerLost?'NativeOwnerLost':failure.errorCode || failure.code || 'OutcomeUnknown';
      const diagnostics={elfPath,device,httpStatus:failure.httpStatus,progress:failure.details?.progress};
      log.dll(`[rmlink] flash failed ${JSON.stringify({errorCode,error:String(error),...diagnostics})}`,{persist:true});
      return {...this.failure<CmsisDapFlashResult>(String(error),errorCode),diagnostics};
    }finally{this.flashing=false;}
  }
  async stepIntoInstruction():Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    const begin=performance.now(),before=await this.readRegister(15);
    if(!before.ok || !before.data)return this.failure(before.message,before.errorCode);
    const step=await this.step();if(!step.ok)return this.failure(step.message,step.errorCode);
    const after=await this.readRegister(15);if(!after.ok || !after.data)return this.failure(after.message,after.errorCode);
    return this.success({pcBefore:before.data.value,pcAfter:after.data.value,classification:'instruction',instructions:1,cleanupOk:true,
      phase:'instruction',timings:{haltMs:0,readPcMs:0,decodeMs:0,executeMs:0,waitMs:0,cleanupMs:0,totalMs:performance.now()-begin}});
  }
  async stepIntoSourceLine(request:NativeStepIntoSourceLineRequest={}):Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    const max=Math.min(256,Math.max(1,request.maxInstructionSteps||128));let first:number|undefined;
    for(let i=0;i<max;i++) {
      const step=await this.stepIntoInstruction();if(!step.ok || !step.data)return step;
      first??=step.data.pcBefore;const pc=step.data.pcAfter;
      if(request.lineStart===undefined || request.lineEnd===undefined || pc<request.lineStart || pc>=request.lineEnd)
        return {...step,data:{...step.data,pcBefore:first,instructions:i+1,phase:'sourceLine'}};
    }
    return this.failure('Source stepping exceeded the instruction budget','ExecutionDeadline');
  }
  async stepOverSourceLine(_request:NativeStepOverRequest={}):Promise<CppJLinkResult<NativeStepOverDiagnostics>> { return this.failure('Step-over decoding and temporary-breakpoint execution are pending'); }
  async stepOut():Promise<CppJLinkResult<NativeStepOutDiagnostics>> { return this.failure('Source stepping is pending'); }
  async disconnect() { await this.dispose();return this.success({}); }
  async dispose() {
    this.connected=false;
    await this.stopCaptureStream();
    await this.client.close().catch(()=>{});this.connected=false;this.scheduler.dispose();
    this.listeners.clear();this.rttData.clear();
    this.rttMemoryEngine.stop();this.rttControlBlockAddress=undefined;this.rttMemoryOnly=false;
    this.streamLostListeners.clear();
    this.activeCaptures.clear();
  }
  getPerformanceDiagnostics() { return {transport:'rmlink-service',boardSubscriptions:true,rttCacheDroppedBytes:this.rttCacheDropped}; }
  getSchedulerSnapshot() { return {...this.scheduler.snapshot()}; }
}
