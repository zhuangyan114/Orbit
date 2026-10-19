import {describe,it,expect,vi} from 'vitest';
import {DapSession} from './dap-session';

function backendModel() {
  const listeners:Array<(sample:any)=>void>=[],stops=vi.fn(async()=>{});
  const backend={supportsProbeSubscriptions:true,
    execute:vi.fn(async(c:any)=>({ok:true,data:c.cmd==='prepareFastDataSampling'?
      c.expressions.map((expression:string)=>({expression,spec:{expression,address:0x20000100,size:4}})): {}})),
    subscribeProbeSamples:vi.fn(async(_kind:any,_specs:any,_period:any,listener:any)=>{listeners.push(listener);return stops;}),
    dispose:async()=>{},
  };
  return {backend,listeners,stops};
}
const req=(seq:number,command:string,args:any)=>({type:'request' as const,seq,command,arguments:args});
describe('DAP RMLink probe subscriptions',()=>{
  it('keeps the probe clock across host pauses and late pre-pause delivery',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    let now=100000;s.nowMs=()=>now;s.phase='connected';s.setTargetRunning(true);
    try {
      await s.handleDataSamplingStart(req(1,'dataSamplingStart',{entries:[{expression:'counter'}]}));
      const emit=(timestampUs:bigint)=>m.listeners[0]({values:[1],validBitmap:1,sequence:0,timestampUs});
      emit(1000000n);
      now+=5;s.setTargetRunning(false);emit(1000500n);
      now+=100;s.setTargetRunning(true);
      // A TCP batch captured just before the pause can arrive after Continue.
      emit(1001000n);emit(1106000n);
      const points=s.dataSamplingPending.get('counter');
      expect(points).toHaveLength(3);
      expect(points[1].timestamp-points[0].timestamp).toBeCloseTo(1,5);
      expect(points[2].timestamp-points[1].timestamp).toBeCloseTo(105,5);
      expect(points[2].startsNewSegment).toBe(true);
    }finally{s.stopDataSampling();await s.probeSamplingCleanup;}
  });
  it('joins skipped deadline slots up to 5 ms but keeps longer and per-field gaps',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    vi.spyOn(s,'timelineNowMs').mockImplementation((...args:unknown[])=>Number(args[0]));
    try {
      await s.handleDataSamplingStart(req(1,'dataSamplingStart',{entries:[{expression:'counter'},{expression:'other'}],sampleIntervalMs:0.2}));
      const emit=(us:bigint,seq:number,valid=3)=>m.listeners[0]({values:[1,2],validBitmap:valid,sequence:seq,timestampUs:us});
      emit(1000000n,0); emit(1000400n,2); emit(1005400n,27);
      emit(1005401n,28,1); emit(1010401n,53);
      const a=s.dataSamplingPending.get('counter'),b=s.dataSamplingPending.get('other');
      expect(a.map((p:any)=>!!p.startsNewSegment)).toEqual([true,false,false,false,false]);
      expect(b.map((p:any)=>!!p.startsNewSegment)).toEqual([true,false,false,true]);
      emit(1015402n,79);
      expect(a.at(-1).startsNewSegment).toBe(true);
    }finally{s.stopDataSampling();await s.probeSamplingCleanup;}
  });
  it('Timeline accepts probe timestamps without launching host read loops and fences old callbacks',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    try {
      await s.handleDataSamplingStart(req(1,'dataSamplingStart',{entries:[{expression:'counter'}],sampleIntervalMs:1}));
      expect(s.dataSamplingTimer).toBeNull();expect(m.backend.execute.mock.calls).toHaveLength(1);
      m.listeners[0]({values:[1],validBitmap:1,sequence:0,timestampUs:1000000n});
      m.listeners[0]({values:[2],validBitmap:1,sequence:1,timestampUs:1001000n});
      const pending=s.dataSamplingPending.get('counter');expect(pending).toHaveLength(2);
      expect(pending[1].timestamp-pending[0].timestamp).toBeCloseTo(1,5);
      await s.handleDataSamplingStop(req(2,'dataSamplingStop',{}));expect(m.stops).toHaveBeenCalledOnce();
      await s.handleDataSamplingStart(req(3,'dataSamplingStart',{entries:[{expression:'counter'}],sampleIntervalMs:1}));
      m.listeners[0]({values:[999],validBitmap:1,sequence:2,timestampUs:1002000n});
      expect(s.dataSamplingPending.get('counter')).toHaveLength(0);
    }finally{s.stopDataSampling();await s.probeSamplingCleanup;}
  });
  it('Watch consumes pushed values and marks invalid fields instead of reading the target again',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    await s.handleWatchEvaluate(req(1,'watchEvaluate',{expressions:['counter']}));
    expect(m.backend.subscribeProbeSamples).toHaveBeenCalledWith('memory_snapshot',expect.any(Array),100000,expect.any(Function));
    m.listeners[0]({values:[123],validBitmap:1});
    expect(s.cachedOrRunningWatchValue('counter').value).toBe(123);
    await s.handleWatchEvaluate(req(2,'watchEvaluate',{expressions:['counter']}));
    expect(m.backend.execute).toHaveBeenCalledOnce();
    m.listeners[0]({values:[0],validBitmap:0});
    expect(s.cachedOrRunningWatchValue('counter').errorCode).toBe('RMLinkInvalidField');
    await s.probeWatchStop();
  });
  it('concurrent Watch evaluations share one subscription instead of replacing the same slot',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    let ready!:()=>void;
    const gate=new Promise<void>(resolve=>ready=resolve);
    m.backend.execute.mockImplementation(async(c:any)=>{
      await gate;return {ok:true,data:c.expressions.map((expression:string)=>({expression,spec:{expression,address:0x20000100,size:4}}))};
    });
    const first=s.handleWatchEvaluate(req(1,'watchEvaluate',{expressions:['counter']}));
    const second=s.handleWatchEvaluate(req(2,'watchEvaluate',{expressions:['counter']}));
    ready();await Promise.all([first,second]);
    expect(m.backend.execute).toHaveBeenCalledOnce();
    expect(m.backend.subscribeProbeSamples).toHaveBeenCalledOnce();
    await s.probeWatchStop();
  });
});
