import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

const MAX_PDSC_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;

export type SvdResolutionSource = 'workspace' | 'local-pack' | 'cache' | 'download' | 'unavailable';

export interface SvdResolution {
  path?: string;
  source: SvdResolutionSource;
  warning?: string;
  packId?: string;
  packVersion?: string;
}

export interface SvdDeviceIdentity {
  device: string;
  series: string;
  family: string;
  packId: string;
}

export interface SvdResolverOptions {
  workspaceRoot?: string;
  cacheRoot: string;
  allowDownload?: boolean;
  localPackRoots?: string[];
  fetchBinary?: (url: string, maxBytes: number) => Promise<Buffer>;
}

export function identifySvdDevice(device: string): SvdDeviceIdentity | undefined {
  const normalized = device.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = /^STM32(WBA|WB|WL|MP[0-9]|[A-Z][0-9])([A-Z0-9]{2})/.exec(normalized);
  if (!match) return undefined;

  const family = match[1];
  const series = `STM32${family}${match[2]}`;
  return {
    device: normalized,
    series,
    family,
    packId: `Keil.STM32${family}xx_DFP`,
  };
}

export async function resolveSvdForDevice(
  device: string,
  options: SvdResolverOptions
): Promise<SvdResolution> {
  const identity = identifySvdDevice(device);
  if (!identity) {
    return unavailable(`无法从芯片型号 ${device || '(空)'} 推导 STM32 SVD 名称`);
  }

  if (options.workspaceRoot) {
    const workspaceSvd = await findMatchingSvd(options.workspaceRoot, identity.series, 6, 10_000);
    if (workspaceSvd) return { path: workspaceSvd, source: 'workspace' };
  }

  const localPackRoots = options.localPackRoots ?? defaultLocalPackRoots();
  for (const root of localPackRoots) {
    const localSvd = await findPackSvd(root, identity);
    if (localSvd) return { path: localSvd, source: 'local-pack', packId: identity.packId };
  }

  const cached = await findPackSvd(options.cacheRoot, identity);
  if (cached) return { path: cached, source: 'cache', packId: identity.packId };

  const extractedFromCache = await extractFromCachedPack(options.cacheRoot, identity);
  if (extractedFromCache) return extractedFromCache;

  if (options.allowDownload === false) {
    return unavailable(`未找到 ${identity.series}.svd，且 orbit.svdAutoDownload 已关闭`, identity.packId);
  }

  try {
    const fetchBinary = options.fetchBinary ?? downloadBinary;
    const pdscUrl = `https://www.keil.com/pack/${identity.packId}.pdsc`;
    const pdsc = (await fetchBinary(pdscUrl, MAX_PDSC_BYTES)).toString('utf8');
    const packVersion = latestPackVersion(pdsc);
    if (!packVersion) {
      return unavailable(`无法从 ${identity.packId}.pdsc 解析 Pack 版本`, identity.packId);
    }

    const packUrl = `https://www.keil.com/pack/${identity.packId}.${packVersion}.pack`;
    const packBuffer = await fetchBinary(packUrl, MAX_PACK_BYTES);
    const extracted = extractMatchingSvd(packBuffer, identity.series);
    if (!extracted) {
      return unavailable(
        `${identity.packId} ${packVersion} 中没有 ${identity.series}.svd`,
        identity.packId,
        packVersion
      );
    }

    const versionRoot = path.join(options.cacheRoot, identity.packId, packVersion);
    await fs.promises.mkdir(versionRoot, { recursive: true });
    const svdPath = path.join(versionRoot, `${identity.series}.svd`);
    const packPath = path.join(versionRoot, `${identity.packId}.${packVersion}.pack`);
    await writeFileAtomic(packPath, packBuffer);
    await writeFileAtomic(svdPath, extracted);

    return {
      path: svdPath,
      source: 'download',
      packId: identity.packId,
      packVersion,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailable(`自动获取 ${identity.series}.svd 失败：${detail}`, identity.packId);
  }
}

export function latestPackVersion(pdsc: string): string | undefined {
  const versions = Array.from(pdsc.matchAll(/<release\s+[^>]*version=["']([^"']+)["']/gi), match => match[1]);
  return versions.sort(compareVersionsDescending)[0];
}

export function extractMatchingSvd(packBuffer: Buffer, series: string): Buffer | undefined {
  const expected = `${series.toUpperCase()}.svd`;
  const zip = new AdmZip(packBuffer);
  const entry = zip.getEntries().find(candidate => {
    if (candidate.isDirectory) return false;
    return path.posix.basename(candidate.entryName.replace(/\\/g, '/')).toUpperCase() === expected.toUpperCase();
  });
  return entry?.getData();
}

async function findPackSvd(root: string, identity: SvdDeviceIdentity): Promise<string | undefined> {
  if (!root) return undefined;
  const candidates = [
    path.join(root, identity.packId),
    path.join(root, 'Keil', `STM32${identity.family}xx_DFP`),
  ];
  for (const candidate of candidates) {
    const found = await findMatchingSvd(candidate, identity.series, 6, 5_000);
    if (found) return found;
  }
  return undefined;
}

async function extractFromCachedPack(
  cacheRoot: string,
  identity: SvdDeviceIdentity
): Promise<SvdResolution | undefined> {
  const packRoot = path.join(cacheRoot, identity.packId);
  let versions: fs.Dirent[];
  try {
    versions = await fs.promises.readdir(packRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const versionNames = versions
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort(compareVersionsDescending);
  for (const packVersion of versionNames) {
    const versionRoot = path.join(packRoot, packVersion);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(versionRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    const packEntry = entries.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pack'));
    if (!packEntry) continue;
    try {
      const packBuffer = await fs.promises.readFile(path.join(versionRoot, packEntry.name));
      const extracted = extractMatchingSvd(packBuffer, identity.series);
      if (!extracted) continue;
      const svdPath = path.join(versionRoot, `${identity.series}.svd`);
      await writeFileAtomic(svdPath, extracted);
      return {
        path: svdPath,
        source: 'cache',
        packId: identity.packId,
        packVersion,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function findMatchingSvd(
  root: string,
  series: string,
  maxDepth: number,
  maxEntries: number
): Promise<string | undefined> {
  const expected = `${series}.svd`.toUpperCase();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < maxEntries) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > maxEntries) break;
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toUpperCase() === expected) return entryPath;
      if (entry.isDirectory() && current.depth < maxDepth && !shouldSkipDirectory(entry.name)) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

function shouldSkipDirectory(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === 'dist' || name === 'out';
}

function defaultLocalPackRoots(): string[] {
  const candidates = [
    process.env.CMSIS_PACK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arm', 'Packs') : undefined,
  ];
  return Array.from(new Set(candidates.filter((candidate): candidate is string => !!candidate)));
}

function compareVersionsDescending(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map(part => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/).map(part => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i++) {
    const leftPart = Number.isFinite(leftParts[i]) ? leftParts[i] : 0;
    const rightPart = Number.isFinite(rightParts[i]) ? rightParts[i] : 0;
    if (leftPart !== rightPart) return rightPart - leftPart;
  }
  return right.localeCompare(left);
}

async function writeFileAtomic(destination: string, data: Buffer): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, data);
  try {
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

function downloadBinary(url: string, maxBytes: number): Promise<Buffer> {
  return downloadBinaryWithRedirects(url, maxBytes, MAX_REDIRECTS);
}

function downloadBinaryWithRedirects(url: string, maxBytes: number, redirectsLeft: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      reject(new Error(`拒绝非 HTTPS 下载地址：${url}`));
      return;
    }

    const request = https.get(parsed, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('SVD Pack 下载重定向次数过多'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, parsed).toString();
        downloadBinaryWithRedirects(redirectUrl, maxBytes, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}：${url}`));
        return;
      }

      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (declaredLength > maxBytes) {
        response.resume();
        reject(new Error(`下载内容超过 ${maxBytes} 字节限制`));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          request.destroy(new Error(`下载内容超过 ${maxBytes} 字节限制`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error('SVD Pack 下载超时')));
    request.on('error', reject);
  });
}

function unavailable(warning: string, packId?: string, packVersion?: string): SvdResolution {
  return { source: 'unavailable', warning, packId, packVersion };
}
