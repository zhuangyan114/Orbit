import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractMatchingSvd,
  identifySvdDevice,
  latestPackVersion,
  resolveSvdForDevice,
} from './svd-resolver';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-svd-test-'));
  temporaryRoots.push(root);
  return root;
}

function packWithSvds(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(entries)) zip.addFile(entry, Buffer.from(content));
  return zip.toBuffer();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SVD device identification', () => {
  it.each([
    ['STM32F407IG', 'STM32F407', 'F4', 'Keil.STM32F4xx_DFP'],
    ['STM32F407IGT6', 'STM32F407', 'F4', 'Keil.STM32F4xx_DFP'],
    ['stm32h723zg', 'STM32H723', 'H7', 'Keil.STM32H7xx_DFP'],
    ['STM32WB55RG', 'STM32WB55', 'WB', 'Keil.STM32WBxx_DFP'],
  ])('maps %s to its device-family pack', (device, series, family, packId) => {
    expect(identifySvdDevice(device)).toMatchObject({ series, family, packId });
  });

  it('rejects a device name that cannot identify an STM32 family', () => {
    expect(identifySvdDevice('Cortex-M4')).toBeUndefined();
  });
});

describe('Keil pack parsing', () => {
  it('selects the newest release independent of XML order', () => {
    expect(latestPackVersion(`
      <release version="2.17.1" />
      <release version="3.0.0" />
      <release version="2.9.9" />
    `)).toBe('3.0.0');
  });

  it('extracts only the exact device-series SVD', () => {
    const pack = packWithSvds({
      'CMSIS/SVD/STM32F405.svd': 'wrong',
      'CMSIS/SVD/STM32F407.svd': 'target',
    });
    expect(extractMatchingSvd(pack, 'STM32F407')?.toString()).toBe('target');
  });
});

describe('SVD resolution priority and caching', () => {
  it('prefers a matching workspace SVD without network access', async () => {
    const workspaceRoot = temporaryRoot();
    const cacheRoot = temporaryRoot();
    const workspaceSvd = path.join(workspaceRoot, 'debug', 'STM32F407.svd');
    fs.mkdirSync(path.dirname(workspaceSvd), { recursive: true });
    fs.writeFileSync(workspaceSvd, '<device/>');

    const result = await resolveSvdForDevice('STM32F407IG', {
      workspaceRoot,
      cacheRoot,
      localPackRoots: [],
      fetchBinary: async () => { throw new Error('network must not be used'); },
    });

    expect(result).toMatchObject({ path: workspaceSvd, source: 'workspace' });
  });

  it('reuses the cached SVD without downloading its pack again', async () => {
    const cacheRoot = temporaryRoot();
    const cachedSvd = path.join(cacheRoot, 'Keil.STM32F4xx_DFP', '3.1.1', 'STM32F407.svd');
    fs.mkdirSync(path.dirname(cachedSvd), { recursive: true });
    fs.writeFileSync(cachedSvd, '<cached/>');

    const result = await resolveSvdForDevice('STM32F407IG', {
      cacheRoot,
      localPackRoots: [],
      fetchBinary: async () => { throw new Error('network must not be used'); },
    });

    expect(result).toMatchObject({ path: cachedSvd, source: 'cache' });
  });

  it('extracts another chip SVD from an already cached family pack without downloading again', async () => {
    const cacheRoot = temporaryRoot();
    const versionRoot = path.join(cacheRoot, 'Keil.STM32F4xx_DFP', '3.1.1');
    fs.mkdirSync(versionRoot, { recursive: true });
    fs.writeFileSync(
      path.join(versionRoot, 'Keil.STM32F4xx_DFP.3.1.1.pack'),
      packWithSvds({
        'CMSIS/SVD/STM32F405.svd': '<f405/>',
        'CMSIS/SVD/STM32F407.svd': '<f407/>',
      })
    );

    const result = await resolveSvdForDevice('STM32F405RG', {
      cacheRoot,
      localPackRoots: [],
      fetchBinary: async () => { throw new Error('network must not be used'); },
    });

    expect(result).toMatchObject({ source: 'cache', packVersion: '3.1.1' });
    expect(result.path && fs.readFileSync(result.path, 'utf8')).toBe('<f405/>');
  });

  it('downloads one family pack, caches it, and extracts only the requested SVD', async () => {
    const cacheRoot = temporaryRoot();
    const urls: string[] = [];
    const pack = packWithSvds({
      'CMSIS/SVD/STM32F405.svd': '<other/>',
      'CMSIS/SVD/STM32F407.svd': '<target/>',
    });

    const result = await resolveSvdForDevice('STM32F407IGT6', {
      cacheRoot,
      localPackRoots: [],
      fetchBinary: async url => {
        urls.push(url);
        return url.endsWith('.pdsc')
          ? Buffer.from('<release version="3.1.1"/>')
          : pack;
      },
    });

    expect(urls).toEqual([
      'https://www.keil.com/pack/Keil.STM32F4xx_DFP.pdsc',
      'https://www.keil.com/pack/Keil.STM32F4xx_DFP.3.1.1.pack',
    ]);
    expect(result.source).toBe('download');
    expect(result.path && fs.readFileSync(result.path, 'utf8')).toBe('<target/>');
    expect(fs.existsSync(path.join(
      cacheRoot,
      'Keil.STM32F4xx_DFP',
      '3.1.1',
      'Keil.STM32F4xx_DFP.3.1.1.pack'
    ))).toBe(true);
    expect(fs.existsSync(path.join(cacheRoot, 'Keil.STM32F4xx_DFP', '3.1.1', 'STM32F405.svd'))).toBe(false);
  });

  it('keeps debugging available when automatic retrieval fails', async () => {
    const result = await resolveSvdForDevice('STM32H723ZG', {
      cacheRoot: temporaryRoot(),
      localPackRoots: [],
      fetchBinary: async () => { throw new Error('offline'); },
    });

    expect(result.source).toBe('unavailable');
    expect(result.warning).toContain('offline');
    expect(result.path).toBeUndefined();
  });
});
