import {afterEach,describe,expect,it,vi} from 'vitest';
import {RMLinkTargetChannel} from './rmlink-target-channel';
import {SessionTargetSelector} from './session-target-channel';
import {OzoneBackend} from './commander';
import type {RMLinkClient} from '../../clients/rmlink/rmlink-client.mjs';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

function fixture(ending:'eof'|'error'='eof') {
  let end!:()=>void;
  const firstEnd=new Promise<void>(resolve=>end=resolve);
  let capture=0,opens=0;
  const client={
    init:vi.fn(async()=>({devices:[{device_id:'probe',paired:true,connected:true}]})),
    open:vi.fn(async()=>{}),close:vi.fn(async()=>{}),
    target:vi.fn(async()=>({state:'Running'})),
    subscribe:vi.fn(async()=>({subscription_id:1,capture_id:++capture})),
    unsubscribe:vi.fn(async()=>{}),
    async *stream({signal}:{signal:AbortSignal}) {
      opens++;
      if(opens===1) {
        await Promise.race([firstEnd,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))]);
        if(ending==='error' && !signal.aborted)throw new Error('capture data socket lost');
        return;
      }
      await tick();
      // An old queued frame must not enter the restarted Timeline.
      for(const id of [capture-1,capture])yield {sample:{subscriptionId:1,kind:1,captureId:id,
        revision:1,sequence:0,timestampUs:1000000n,durationUs:0,validBitmap:1,flags:0,values:[id]}};
      await new Promise<void>(resolve=>{
        if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});
      });
    },
  };
  const owner=new RMLinkTargetChannel(client as unknown as RMLinkClient);
  const forbidden=()=>{throw new Error('second owner');};
  const selector=new SessionTargetSelector(forbidden,forbidden,()=>owner);
  const backend=new OzoneBackend();(backend as any).sessionTarget=selector;
  return {client,owner,selector,backend,end,opens:()=>opens};
}

describe('RMLink Timeline stream recovery on the existing owner',()=>{
  afterEach(()=>vi.useRealTimers());
  it('keeps retry backoff through short sample bursts and resets it after sustained progress',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    let capture=0,emit!:(sample:any)=>void,lost!:()=>void;
    const target={usingNative:true,
      subscribe:vi.fn(async()=>({subscription_id:1,capture_id:++capture})),unsubscribe:vi.fn(async()=>{}),
      onCapture:(listener:any)=>{emit=listener;return ()=>{};},
      onCaptureStreamLost:(listener:any)=>{lost=listener;return ()=>{};},
    };
    const backend=new OzoneBackend();(backend as any).sessionTarget=target;
    const stop=await backend.subscribeProbeSamples('memory_series',[{expression:'counter',address:0x20000100,size:4}],200,()=>{});
    const sample=()=>emit({subscriptionId:1,kind:1,captureId:capture,values:[1]});
    try {
      lost();await vi.advanceTimersByTimeAsync(500);expect(capture).toBe(2);
      sample();await vi.advanceTimersByTimeAsync(100);sample();lost();
      await vi.advanceTimersByTimeAsync(500);expect(capture).toBe(2);
      await vi.advanceTimersByTimeAsync(500);expect(capture).toBe(3);
      sample();
      for(let i=0;i<13;i++){await vi.advanceTimersByTimeAsync(250);sample();}
      lost();await vi.advanceTimersByTimeAsync(500);expect(capture).toBe(4);
    }finally{await stop();}
  });
  it.each(['eof','error'] as const)('automatically recreates Timeline after %s without a new debug owner',async ending=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=fixture(ending),samples:any[]=[];
    let stop:(()=>Promise<void>)|undefined;
    try {
      expect((await f.selector.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'probe'})).ok).toBe(true);
      stop=await f.backend.subscribeProbeSamples('memory_series',[{expression:'counter',address:0x20000100,size:4}],200,sample=>samples.push(sample));
      expect(f.client.subscribe).toHaveBeenCalledWith('memory_series',expect.objectContaining({realtime:true}));
      await tick();f.end();await tick();
      await vi.advanceTimersByTimeAsync(500);await tick();
      expect(f.client.subscribe).toHaveBeenCalledTimes(2);
      expect(f.opens()).toBe(2);
      expect(samples.map(s=>s.captureId)).toEqual([2]);
      expect(f.client.open).toHaveBeenCalledOnce();expect(f.client.close).not.toHaveBeenCalled();
      expect(f.client.target.mock.calls).toHaveLength(1);
      await stop();stop=undefined;
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.client.subscribe).toHaveBeenCalledTimes(2);
    }finally{await stop?.();await f.owner.dispose();}
  });
  it('cancels a pending retry when the user unchecks Timeline',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=fixture();
    try {
      await f.selector.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'probe'});
      const stop=await f.backend.subscribeProbeSamples('memory_series',[{expression:'counter',address:0x20000100,size:4}],200,()=>{});
      await tick();f.end();await tick();await stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.client.subscribe).toHaveBeenCalledOnce();
      expect(f.client.unsubscribe).toHaveBeenCalledOnce();
    }finally{await f.owner.dispose();}
  });
  it.each(['subscribe','unsubscribe'] as const)('retries a transient %s failure without duplicating a slot',async phase=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=fixture();let stop:(()=>Promise<void>)|undefined;
    try {
      await f.selector.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'probe'});
      stop=await f.backend.subscribeProbeSamples('memory_series',[{expression:'counter',address:0x20000100,size:4}],200,()=>{});
      f.client[phase].mockRejectedValueOnce(new Error('temporary data transport failure'));
      await tick();f.end();await tick();
      await vi.advanceTimersByTimeAsync(500);await tick();
      const calls=f.client.subscribe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(999);expect(f.client.subscribe).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);await tick();
      expect(f.opens()).toBe(2);
      expect(f.client.subscribe).toHaveBeenCalledTimes(phase==='subscribe'?3:2);
      expect(f.client.unsubscribe).toHaveBeenCalledTimes(phase==='subscribe'?1:2);
      expect(f.client.open).toHaveBeenCalledOnce();
    }finally{await stop?.();await f.owner.dispose();}
  });
  it('drains a replacement already in flight when the user cancels',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=fixture(),samples:any[]=[];let release!:()=>void;
    try {
      await f.selector.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'probe'});
      const stop=await f.backend.subscribeProbeSamples('memory_series',[{expression:'counter',address:0x20000100,size:4}],200,s=>samples.push(s));
      f.client.subscribe.mockImplementationOnce(async()=>{
        await new Promise<void>(resolve=>release=resolve);return {subscription_id:1,capture_id:2};
      });
      await tick();f.end();await tick();await vi.advanceTimersByTimeAsync(500);
      expect(f.client.subscribe).toHaveBeenCalledTimes(2);
      const stopping=stop();release();await stopping;
      await vi.advanceTimersByTimeAsync(10000);await tick();
      expect(samples).toEqual([]);expect(f.client.unsubscribe).toHaveBeenCalledTimes(2);
      expect(f.client.subscribe).toHaveBeenCalledTimes(2);
    }finally{release?.();await f.owner.dispose();}
  });
  it('does not replay a snapshot subscription on a shared data stream failure',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=fixture();let stop:(()=>Promise<void>)|undefined;
    try {
      await f.selector.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'probe'});
      stop=await f.backend.subscribeProbeSamples('memory_snapshot',[{expression:'counter',address:0x20000100,size:4}],100000,()=>{});
      await tick();f.end();await tick();await vi.advanceTimersByTimeAsync(10000);
      expect(f.client.subscribe).toHaveBeenCalledOnce();
    }finally{await stop?.();await f.owner.dispose();}
  });
  it.each(['control','service'] as const)('stops retrying when the %s owner is lost',async phase=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=fixture();let stop:(()=>Promise<void>)|undefined;
    try {
      await f.selector.connect({probe:'rmlink',device:'STM32F103C8',speedKHz:4000,rmlinkDeviceId:'probe'});
      stop=await f.backend.subscribeProbeSamples('memory_series',[{expression:'counter',address:0x20000100,size:4}],200,()=>{});
      await tick();f.end();await tick();
      if(phase==='control') {
        f.client.target.mockRejectedValueOnce(new Error('control owner lost'));
        expect((await f.owner.getState()).ok).toBe(false);
      }else f.client.subscribe.mockRejectedValueOnce(Object.assign(new Error('service session lost'),{httpStatus:503,ownerLost:true}));
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.client.subscribe).toHaveBeenCalledTimes(phase==='control'?1:2);
      expect(f.client.open).toHaveBeenCalledOnce();
    }finally{await stop?.();await f.owner.dispose();}
  });
});
