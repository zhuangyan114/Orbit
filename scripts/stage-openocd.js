'use strict';
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'resources', 'openocd');
const archive = path.join(vendor, 'openocd-6fbe9e7-i686-w64-mingw32.tar.gz');
const expected = 'd4ed61f96aec07fcacac532e27e9f356c03ecc24d7a209fe65c893d3cea6b6ec';
const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (actual !== expected) throw new Error('OpenOCD archive does not match the pinned build');

const output = path.join(root, 'out', 'openocd');
fs.mkdirSync(output, { recursive: true });
const runtime = [
  'bin/openocd.exe', 'bin/libftdi1.dll', 'bin/libgcc_s_dw2-1.dll', 'bin/libhidapi-0.dll',
  'bin/libjaylink-0.dll', 'bin/libusb-1.0.dll', 'bin/libwinpthread-1.dll',
  'share/openocd/scripts', 'share/doc/hidapi',
];
const extract = spawnSync('tar', ['-xzf', archive, '-C', output, ...runtime], { stdio: 'inherit' });
if (extract.error) throw extract.error;
if (extract.status !== 0) throw new Error('OpenOCD runtime extraction failed');
for (const item of runtime) fs.accessSync(path.join(output, item));
