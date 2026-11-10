import { beforeEach,describe,expect,it,vi } from 'vitest';

vi.mock('fs',()=>({mkdirSync:vi.fn(),writeFileSync:vi.fn(),appendFileSync:vi.fn()}));

describe('persistent DLL diagnostics',()=>{
  beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});

  it('preserves the dated failure history across startup log clearing',async()=>{
    const fs=await import('fs');
    const {configureLogger,log}=await import('./logger');
    const stderr=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
    try {
      configureLogger({enabled:true,clearOnStart:true});
      log.dll('[rmlink] flash failed {"probe_error":10}',{persist:true});
      const history=vi.mocked(fs.appendFileSync).mock.calls.find(([file])=>String(file).endsWith('dll-history.log'));
      expect(history).toBeDefined();
      expect(String(history?.[1])).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z \[DLL\] \[rmlink\] flash failed/);
      vi.resetModules();
      const next=await import('./logger');
      next.configureLogger({clearOnStart:true});
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.stringContaining('dll-history.log'),expect.anything());
      expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
    }finally{stderr.mockRestore();}
  });
});
