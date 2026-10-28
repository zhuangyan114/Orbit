import { describe,it,expect } from 'vitest';
import { RMLinkTargetChannel } from './rmlink-target-channel';
import { SessionTargetSelector } from './session-target-channel';
import type { RMLinkClient } from '../../clients/rmlink/rmlink-client.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

class ClientModel {
  opened=0;closed=0;calls:string[]=[];failed=false;rejectOnce=false;
  images:Array<{data:Buffer;address:number}>=[];
  streamOpens=0;flashError:Error|null=null;flashSignal:AbortSignal|undefined;
  devices=[{device_id:'50787d15a924',paired:true,connected:true}];
  async init() {return {devices:this.devices};}
  async open() {this.opened++;}
  async close() {this.closed++;}
  async target(command:string) {
    this.calls.push(command);if(this.failed)throw new Error('owner lost');
    if(this.rejectOnce){this.rejectOnce=false;throw Object.assign(new Error('invalid register'),{httpStatus:400,errorCode:'InvalidRequest'});}
    if(command==='read_memory')return {data:'78563412'};
    if(command==='state')return {state:'Running'};
    if(command==='halt' || command==='step')return {command,dhcsr:0x30003};
    if(command==='run')return {command,dhcsr:0x10001};
    if(command==='read_register')return {value:0x08000100};
    return {};
  }
  async subscribe() {return {subscription_id:3,capture_id:1};}
  async unsubscribe() {}
  async flashImage(data:Uint8Array,address:number,signal?:AbortSignal) {
    this.flashSignal=signal;this.images.push({data:Buffer.from(data),address});
    if(this.flashError)throw this.flashError;
    return {verified:true,verification:'probe_full_compare',host_verified:false,probe_verified:true};
  }
  async *stream({signal}:{signal:AbortSignal}) {
    this.streamOpens++;
    yield {sample:{subscriptionId:3,kind:3,captureId:0,revision:1,sequence:0,timestampUs:0n,durationUs:0,validBitmap:0,flags:0,channel:0,byteSequence:0n,data:Buffer.from('old')}};
    yield {sample:{subscriptionId:3,kind:3,captureId:1,revision:1,sequence:0,timestampUs:1n,durationUs:0,validBitmap:0,flags:0,channel:0,byteSequence:0n,data:Buffer.from('abc')}};
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  }
}
describe('RMLink public-service owner',()=>{
  it('runs to an entry address through the same public service owner',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    await owner.connect({device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'50787d15a924'});
    let received:any;
    model.target=async(command:string,parameters?:any)=>{received={command,parameters};return {state:'Halted',pc:0x08001000,cleanupOk:true} as any;};
    expect(await owner.runToAddress(0x08001001,true)).toMatchObject({ok:true,targetState:'Halted',data:{pc:0x08001000,cleanupOk:true}});
    expect(received).toEqual({command:'run_to_address',parameters:{address:0x08001001,reset:true}});
    expect(model.opened).toBe(1);await owner.dispose();
  });
  it('routes probe=rmlink to one service owner without requiring USB selectors or a device ID',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    const forbidden=()=>{throw new Error('competing probe');};
    const selector=new SessionTargetSelector(forbidden,forbidden,forbidden,()=>owner);
    expect(await selector.connect({probe:'rmlink',device:'STM32F103C8',interface:'SWD',speedKHz:4000}))
      .toMatchObject({ok:true,data:{diagnostics:{transport:'rmlink-service',deviceId:'50787d15a924'}}});
    expect(model.opened).toBe(1);expect(model.calls).toEqual(['connect']);
    await selector.dispose();expect(model.closed).toBe(1);
  });
  it('never guesses between multiple paired devices or falls back after a busy target',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    model.devices.push({device_id:'50787d15a925',paired:true,connected:true});
    expect((await owner.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000})).errorCode).toBe('AmbiguousDevice');
    expect(model.opened).toBe(0);
    model.devices=[];
    expect((await owner.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000})).errorCode).toBe('DeviceNotFound');
    model.target=async()=>{throw Object.assign(new Error('busy'),{errorCode:'TargetBusy',httpStatus:409});};
    const forbidden=()=>{throw new Error('competing probe');};
    const selector=new SessionTargetSelector(forbidden,forbidden,forbidden,()=>owner);
    expect(await selector.connect({probe:'rmlink',rmlinkDeviceId:'50787d15a924',device:'STM32F103C8',speedKHz:4000}))
      .toMatchObject({ok:false,errorCode:'TargetBusy',message:expect.stringContaining('未执行烧录')});
    expect(selector.ownerKind).toBe('none');expect(model.opened).toBe(1);
  });
  it('preserves observed Cortex-M control state through the service owner contract',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    await owner.connect({device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'50787d15a924'});
    expect((await owner.halt()).targetState).toBe('Halted');
    expect((await owner.step()).targetState).toBe('Halted');
    expect((await owner.run()).targetState).toBe('Running');
    expect((await owner.getState()).targetState).toBe('Running');
    await owner.dispose();
  });
  it('selects exactly one service owner and never constructs a competing probe',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    const forbidden=()=>{throw new Error('competing probe');};
    const selector=new SessionTargetSelector(forbidden,forbidden,forbidden,()=>owner);
    expect((await selector.connect({device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'50787d15a924'})).ok).toBe(true);
    expect((await selector.readMemory(0x20000000,4)).data?.bytes).toEqual(Buffer.from('78563412','hex'));
    expect(model.opened).toBe(1);await selector.dispose();expect(model.closed).toBe(1);
  });
  it('RTT reads consume the subscription cache without target polling',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    await owner.connect({device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'50787d15a924'});
    expect((await owner.startRtt(0x20000400)).ok).toBe(true);
    await new Promise(resolve=>setImmediate(resolve));
    expect((await owner.readRtt(0,2)).data?.bytes.toString()).toBe('ab');
    expect((await owner.readRtt(0,2)).data?.bytes.toString()).toBe('c');
    expect(model.calls).toEqual(['connect']);await owner.dispose();
  });
  it('owner loss terminates access and source stepping is explicit',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    await owner.connect({device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'50787d15a924'});
    expect((await owner.stepOut()).errorCode).toBe('UnsupportedCapability');
    expect((await owner.stepIntoInstruction()).data?.classification).toBe('instruction');
    model.failed=true;expect((await owner.halt()).errorCode).toBe('NativeOwnerLost');
    expect(owner.usingNative).toBe(false);await owner.dispose();
  });
  it('a rejected command keeps the existing owner available for the next valid command',async()=>{
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    await owner.connect({device:'STM32F103C8',speedKHz:0,rmlinkDeviceId:'50787d15a924'});
    model.rejectOnce=true;expect((await owner.readRegister(19)).errorCode).toBe('InvalidRequest');
    expect(owner.usingNative).toBe(true);expect((await owner.halt()).ok).toBe(true);
    await owner.dispose();
  });
  it('ELF Flash uses physical load addresses and page padding through the same public client',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'rmlink-elf-'));
    const elf=Buffer.alloc(0x104);elf.set([0x7f,0x45,0x4c,0x46,1,1,1]);
    elf.writeUInt16LE(2,16);elf.writeUInt16LE(40,18);elf.writeUInt32LE(1,20);
    elf.writeUInt32LE(0x34,28);elf.writeUInt16LE(32,42);elf.writeUInt16LE(1,44);
    // .data VMA in RAM, LMA in Flash. The ELF parser must select the latter.
    for(const [offset,value] of [[0,1],[4,0x100],[8,0x20000000],[12,0x08000104],[16,4],[20,4],[24,6],[28,4]])elf.writeUInt32LE(value,0x34+offset);
    elf.set([1,2,3,4],0x100);const path=join(directory,'fixture.elf');await writeFile(path,elf);
    const model=new ClientModel(),owner=new RMLinkTargetChannel(model as unknown as RMLinkClient);
    try {
      await owner.connect({device:'STM32F103C8',speedKHz:0,rmlinkDeviceId:'50787d15a924'});
      await owner.startRtt(0x20000400);await new Promise(resolve=>setImmediate(resolve));
      expect(model.streamOpens).toBe(1);
      const result=await owner.flash(path,'STM32F103C8');
      expect(result.ok).toBe(true);
      expect(result.data?.diagnostics?.verification).toBe('probe_full_compare');
      expect(owner.usingNative).toBe(true);
      await owner.startRtt(0x20000400);await new Promise(resolve=>setImmediate(resolve));
      expect(model.streamOpens).toBe(2);
      expect((await owner.readRtt(0,10)).data?.bytes.toString()).toBe('abc');
      expect(model.opened).toBe(1);expect(model.images).toHaveLength(1);
      expect(model.images[0].address).toBe(0x08000000);expect(model.images[0].data.length).toBe(1024);
      expect([...model.images[0].data.subarray(0x104,0x108)]).toEqual([1,2,3,4]);expect(model.images[0].data[0]).toBe(255);
      const abort=new AbortController();abort.abort();
      expect((await owner.flash(path,'STM32F103C8',{signal:abort.signal})).errorCode).toBe('RequestCancelled');
      expect((await owner.flash(path,'STM32F407VE')).errorCode).toBe('TargetMismatch');
      expect(model.images).toHaveLength(1);
      model.flashError=Object.assign(new Error('Board cancelled and halted'),{errorCode:'FlashCancelled',httpStatus:409});
      const cancellation=new AbortController();
      expect((await owner.flash(path,'STM32F103C8',{signal:cancellation.signal})).errorCode).toBe('RequestCancelled');
      expect(model.flashSignal).toBe(cancellation.signal);
      expect(owner.usingNative).toBe(true);
    }finally{await owner.dispose();await rm(directory,{recursive:true,force:true});}
  });
});
