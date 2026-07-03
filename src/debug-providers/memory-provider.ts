import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { MemoryBlock } from '../ozone-backend/types';

export class MemoryProvider {
  private cache: Map<number, MemoryBlock> = new Map();

  constructor(private backend: OzoneBackend) {}

  async read(address: number, size: number): Promise<MemoryBlock | null> {
    const result = await this.backend.execute({ cmd: 'readMemory', address, size });
    if (result.ok) {
      const block = result.data as MemoryBlock;
      this.cache.set(address, block);
      return block;
    }
    vscode.window.showErrorMessage(`Memory read failed @ 0x${address.toString(16)}`);
    return null;
  }

  async write(address: number, data: number[]): Promise<boolean> {
    const result = await this.backend.execute({ cmd: 'writeMemory', address, data });
    if (result.ok) {
      this.cache.delete(address);
      return true;
    }
    return false;
  }

  getCached(address: number): MemoryBlock | undefined {
    return this.cache.get(address);
  }

  clearCache() {
    this.cache.clear();
  }
}