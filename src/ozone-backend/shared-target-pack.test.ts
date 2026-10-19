import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RMLinkTargetChannel} from './rmlink-target-channel';
import {listFlashTargets} from './cmsis-dap-flasher';
import type {RMLinkClient} from '../../clients/rmlink/rmlink-client.mjs';

class Client {
  calls:Array<{command:string;parameters:any}>=[];
  images:Array<{data:Buffer;address:number;options:any}>=[];
  async init(){return {devices:[{device_id:'model',paired:true,connected:true}]};}
  async open(){}
  async close(){}
  async target(command:string,parameters:any){this.calls.push({command,parameters});return {};}
  async unsubscribe(){}
  async flashImage(data:Uint8Array,address:number,_signal:any,options:any){
    this.images.push({data:Buffer.from(data),address,options});return {verified:true};
  }
}
function elf(loads:Array<{address:number;lma?:number;bytes:number[]}>){
  const bytes=Buffer.alloc(52+loads.length*32+loads.reduce((n,l)=>n+l.bytes.length,0));
  bytes.set([0x7f,0x45,0x4c,0x46,1,1,1]);bytes.writeUInt16LE(2,16);bytes.writeUInt16LE(40,18);bytes.writeUInt32LE(1,20);
  bytes.writeUInt32LE(52,28);bytes.writeUInt16LE(52,40);bytes.writeUInt16LE(32,42);bytes.writeUInt16LE(loads.length,44);
  let offset=52+loads.length*32;
  loads.forEach((load,i)=>{const h=52+i*32;bytes.writeUInt32LE(1,h);bytes.writeUInt32LE(offset,h+4);bytes.writeUInt32LE(load.address,h+8);
    bytes.writeUInt32LE(load.lma??load.address,h+12);bytes.writeUInt32LE(load.bytes.length,h+16);bytes.writeUInt32LE(load.bytes.length,h+20);bytes.writeUInt32LE(5,h+24);
    bytes.set(load.bytes,offset);offset+=load.bytes.length;});
  return bytes;
}
async function fixture(loads:Parameters<typeof elf>[0],run:(file:string)=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),'shared-target-'));
  try{const file=join(directory,'fixture.elf');await writeFile(file,elf(loads));await run(file);}finally{await rm(directory,{recursive:true,force:true});}
}
describe('shared Orbit / RMLink target package',()=>{
  it('connects and programs every registered CMSIS-DAP target through the same service owner',async()=>{
    for(const target of listFlashTargets()){
      const client=new Client(),owner=new RMLinkTargetChannel(client as unknown as RMLinkClient);
      expect((await owner.connect({device:target.name,speedKHz:4000})).ok).toBe(true);
      expect(client.calls[0]).toEqual({command:'connect',parameters:{clock_hz:4000000,device:target.name}});
      await fixture([{address:0x08000000,bytes:[1,2,3,4]}],async file=>{
        const result=await owner.flash(file,target.name);expect(result.ok).toBe(true);
        expect(client.images[0].data.length).toBe(target.sectors[0].size);
        expect([...client.images[0].data.subarray(0,4)]).toEqual([1,2,3,4]);
      });await owner.dispose();
    }
  });
  it('keeps .data Flash LMA and coalesces an H7 ECC word before upload',async()=>{
    const client=new Client(),owner=new RMLinkTargetChannel(client as unknown as RMLinkClient);
    await owner.connect({device:'STM32H723VG',speedKHz:4000});
    await fixture([{address:0x08000000,bytes:[1,2,3]},{address:0x24001000,lma:0x08000003,bytes:[4,5,6]}],async file=>{
      expect((await owner.flash(file,'STM32H723VG')).ok).toBe(true);
      expect([...client.images[0].data.subarray(0,8)]).toEqual([1,2,3,4,5,6,255,255]);
      expect(client.images[0].data.length).toBe(128*1024);
    });await owner.dispose();
  });
  it('uploads separate sparse sector groups and keeps the core halted between them',async()=>{
    const client=new Client(),owner=new RMLinkTargetChannel(client as unknown as RMLinkClient);
    await owner.connect({device:'STM32F407VE',speedKHz:4000});
    await fixture([{address:0x08000000,bytes:[1,2]},{address:0x08020000,bytes:[3,4]}],async file=>{
      const result=await owner.flash(file,'STM32F407VE');expect(result.ok).toBe(true);
      expect(client.images.map(i=>i.address)).toEqual([0x08000000,0x08020000]);
      expect(client.images.map(i=>i.data.length)).toEqual([16384,131072]);
      expect(client.images.map(i=>i.options.resetAfter)).toEqual([false,true]);
      expect(result.data?.erasedSectors.map(s=>s.number)).toEqual([0,5]);
    });await owner.dispose();
  });
  it('rejects a different density or an overflowing ELF before any image upload',async()=>{
    const client=new Client(),owner=new RMLinkTargetChannel(client as unknown as RMLinkClient);
    await owner.connect({device:'STM32F407VE',speedKHz:4000});
    await fixture([{address:0x08080000,bytes:[1,2]}],async file=>{
      expect((await owner.flash(file,'STM32F407IG')).errorCode).toBe('TargetMismatch');
      expect((await owner.flash(file,'STM32F407VE')).ok).toBe(false);
      expect(client.images).toHaveLength(0);
    });await owner.dispose();
  });
});
