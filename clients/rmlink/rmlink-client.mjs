/** Public connector SDK. One instance per physical target owner.
 * Target control, subscriptions and recording use the shared local service.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function decodeCaptureFrame(frame) {
  const r = Buffer.from(frame);
  if (r.length < 56 || r.toString('ascii',0,4) !== 'RML1' || r[4] !== 1 ||
      ![1,2,3].includes(r[5]) || r[6] < 1 || r[6] > 4 || r[7] || r.readUInt16LE(24) !== 1 || r.readUInt16LE(26) !== 32 ||
      r.readUInt32LE(20) !== r.length-32 || r.readUInt16LE(54) !== r.length-56 || r.readUInt32LE(16)!==r.readUInt32LE(32)) throw new Error('Invalid capture frame');
  let crc = 0xffffffff;
  for (const byte of r.subarray(32)) {
    crc ^= byte;
    for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  if (((crc ^ 0xffffffff) >>> 0) !== r.readUInt32LE(28)) throw new Error('Capture CRC mismatch');
  const result = {subscriptionId:r[6],kind:r[5],captureId:r.readUInt32LE(8),revision:r.readUInt32LE(12),
    sequence:r.readUInt32LE(32),timestampUs:r.readBigUInt64LE(36),durationUs:r.readUInt32LE(44),
    validBitmap:r.readUInt32LE(48),flags:r.readUInt16LE(52)};
  if (r[5] === 3) {
    if (r.length < 72 || r.readUInt32LE(68) !== r.length-72) throw new Error('Invalid RTT frame');
    return {...result,channel:r.readUInt32LE(56),byteSequence:r.readBigUInt64LE(60),data:Buffer.from(r.subarray(72))};
  }
  if ((r.length-56)%4 || r.length>184 || r.length<60) throw new Error('Invalid memory frame');
  const count=(r.length-56)/4, mask=count===32?0xffffffff:2**count-1;
  if (((result.validBitmap & ~mask) >>> 0)!==0)throw new Error('Invalid memory validity bitmap');
  return {...result, values:Array.from({length:(r.length-56)/4},(_,i)=>r.readUInt32LE(56+i*4))};
}

export class RMLinkClient {
  constructor({ port = 3243, stateDirectory = join(process.env.USERPROFILE, '.rmlink'), onLost = () => {} } = {}) {
    this.base = `http://127.0.0.1:${port}/v1`;
    this.stateDirectory = stateDirectory;
    this.onLost = onLost;
    this.session = null;
    this.timer = null;
    this.packetSize = 64;
    this.streamCursor=null;
    this.flashPending=false;
  }
  async request(method, path, body, timeoutMs = 30000) {
    const response = await fetch(this.base + path, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || `RMLink HTTP ${response.status}`);
      error.httpStatus = response.status;
      error.errorCode = result.code || (response.status === 400 ? 'InvalidRequest' : 'RMLinkRequestFailed');
      error.details = result;
      error.ownerLost = response.status === 503;
      throw error;
    }
    return result;
  }
  async init() {
    this.token = JSON.parse(await readFile(join(this.stateDirectory, 'connector.json'), 'utf8')).token;
    return this.request('GET', '/status');
  }
  async open(deviceId) {
    if (this.session) throw new Error('RMLink session already open');
    const result = await this.request('POST', '/sessions', { device_id: deviceId });
    this.session = result.session_id;
    this.packetSize = result.packet_size ?? 64;
    if (![64,128,256,512].includes(this.packetSize)) {
      await this.close(); throw new Error('Invalid negotiated RMLink packet size');
    }
    const session = this.session;
    this.timer = setInterval(() => {
      this.request('POST', `/sessions/${this.session}/heartbeat`).catch(error => {
        if (this.session === session) {
          clearInterval(this.timer); this.timer = null; this.session = null; this.onLost(error);
        }
      });
    }, result.heartbeat_seconds * 1000);
    this.timer.unref?.();
  }
  async exchange(packets, priority = 'control') {
    if (!this.session) throw new Error('RMLink owner lost or session closed');
    if (!Array.isArray(packets) || packets.length < 1 || packets.length > 8 ||
        packets.some(p => p.length < 1 || p.length > this.packetSize || p[0] === 7)) throw new Error('Invalid DAP batch');
    let result;
    const session = this.session;
    try {
      result = await this.request('POST', `/sessions/${session}/dap`, {
        packets: packets.map(p => Buffer.from(p).toString('hex')), priority,
      });
    } catch (error) {
      if (error.ownerLost && this.session === session) {
        clearInterval(this.timer); this.timer = null; this.session = null; this.onLost(error);
      }
      throw error;
    }
    if (!Array.isArray(result.responses) || result.responses.length !== packets.length ||
        result.responses.some(r => !new RegExp(`^(?:[0-9a-f]{2}){1,${this.packetSize}}$`).test(r))) throw new Error('Malformed RMLink response');
    return result.responses.map(r => Buffer.from(r, 'hex'));
  }
  async abort() { return this.request('POST', `/sessions/${this.session}/abort`); }
  async timeSync(deviceId, samples = 8) {
    return this.request('POST', `/devices/${deviceId}/time-sync`, {samples});
  }
  async setTransport(deviceId, transport) {
    return this.request('POST', '/transport', {device_id:deviceId,transport});
  }
  async target(command, parameters = {}) {
    return this.request('POST', `/sessions/${this.session}/target`, {command, ...parameters});
  }
  async deviceHealth(deviceId) {return this.request('GET',`/devices/${deviceId}/health`);}
  async flashImage(data, address = 0x08000000, signal, {backend = 'auto',verifyOnHost = false,resetAfter=true,timeoutMs=180000} = {}) {
    if (!this.session) throw new Error('RMLink owner lost or session closed');
    if (this.flashPending) throw new Error('Flash upload already running');
    const image=Buffer.from(data), path=`/sessions/${this.session}/flash`;
    let started=false,cancelRequest,cancelError;
    const check=()=>{if(signal?.aborted){const error=new Error('Flash cancelled');error.name='AbortError';throw error;}};
    const cancel=()=>{
      if(started && !cancelRequest)cancelRequest=this.request('POST',path,{action:'cancel'}).catch(error=>{cancelError=error;});
    };
    this.flashPending=true;
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      check();started=true;
      await this.request('POST',path,{action:'begin',address,byte_length:image.length,sha256:createHash('sha256').update(image).digest('hex'),backend,verify_on_host:verifyOnHost,reset_after:resetAfter});
      for(let offset=0;offset<image.length;offset+=4096){check();await this.request('POST',path,{action:'chunk',offset,data:image.subarray(offset,offset+4096).toString('hex')});}
      check();
      // Keep the commit response alive: aborting fetch alone cannot stop the
      // target. A separate cancel request asks the executor to stop safely.
      return await this.request('POST',path,{action:'commit'},timeoutMs);
    } catch(error) {
      await cancelRequest;
      if(cancelError)error.cancelRequestError=cancelError;
      throw error;
    } finally {
      signal?.removeEventListener('abort',cancel);
      // Finish this cancellation before another upload can replace its state.
      await cancelRequest;this.flashPending=false;
    }
  }
  async subscribe(kind, parameters = {}) {
    const result=await this.request('POST', `/sessions/${this.session}/subscriptions`, {kind, ...parameters});
    this.streamCursor??=result.stream_cursor ?? -1;
    return result;
  }
  async flashStatus() {
    if(!this.session)throw new Error('RMLink session closed');
    return this.request('GET',`/sessions/${this.session}/flash`);
  }
  async cancelFlash() {
    if(!this.session)throw new Error('RMLink session closed');
    return this.request('POST',`/sessions/${this.session}/flash`,{action:'cancel'});
  }
  async subscription(id, action = 'status') {
    return this.request(action === 'status' ? 'GET' : 'POST', `/sessions/${this.session}/subscriptions/${id}`,
      action === 'status' ? undefined : {action});
  }
  async unsubscribe(id) { return this.request('DELETE', `/sessions/${this.session}/subscriptions/${id}`); }
  async startRecording(options = {}) {return this.request('POST',`/sessions/${this.session}/recordings`,options);}
  async recording(id, stop = false) {return this.request(stop?'POST':'GET',`/sessions/${this.session}/recordings/${id}`,stop?{action:'stop'}:undefined);}
  async *stream({signal,after=this.streamCursor ?? -1} = {}) {
    if (!this.session) throw new Error('RMLink session closed');
    const response = await fetch(this.base + `/sessions/${this.session}/stream?after=${after}`, {
      headers: {Authorization: `Bearer ${this.token}`}, signal,
    });
    if (!response.ok) throw new Error(`RMLink stream HTTP ${response.status}`);
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of response.body) {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 12) {
          const size = pending.readUInt32LE(8);
          if (size === 0) { pending = pending.subarray(12); continue; }
          if (size < 56 || size > 384) throw new Error('Capture frame length invalid');
          if (pending.length < 12 + size) break;
          const cursor = pending.readBigUInt64LE(0);
          const frame = Buffer.from(pending.subarray(12,12+size));
          this.streamCursor=cursor;
          yield {cursor, frame, sample:decodeCaptureFrame(frame)};
          pending = pending.subarray(12+size);
        }
        if (pending.length > 396) throw new Error('Capture accumulator bound');
      }
      if (pending.length) throw new Error('Truncated capture stream');
    } finally { await response.body.cancel().catch(() => {}); }
  }
  async close() {
    clearInterval(this.timer); this.timer = null;
    const session = this.session; this.session = null;
    this.streamCursor=null;
    if (session) await this.request('DELETE', `/sessions/${session}`);
  }
}
