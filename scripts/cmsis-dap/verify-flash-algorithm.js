'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const imagePath = path.join(repositoryRoot, 'out', 'native', 'win32-x64', 'orbit-stm32f407-flash-algorithm.bin');
const sourcePath = path.join(repositoryRoot, 'native', 'cmsis-dap-flash-algorithm', 'stm32f407_flash_algorithm.c');
const entryOffsets = [0x000, 0x100, 0x200, 0x300, 0x400];
const bkptOffset = 0x500;

if (!fs.existsSync(imagePath)) {
  throw new Error(`Flash Algorithm image is missing: ${imagePath}`);
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`Flash Algorithm source is missing: ${sourcePath}`);
}

const source = fs.readFileSync(sourcePath, 'utf8');
const initBody = source.match(/int Init\([\s\S]*?\n}\n\n__attribute__\(\(section\(\"\.text\.uninit\"/);
if (!initBody || !initBody[0].includes('wait_busy()') || initBody[0].includes('wait_ready()')) {
  throw new Error('Init must wait for BSY only, clear stale status flags, and then unlock Flash');
}
if (!source.includes('cpsid i') || source.includes('cpsie i')) {
  throw new Error('Flash Algorithm must keep interrupts masked through the RAM return-to-BKPT path');
}
const programMode = source.match(/static int select_program_mode\([\s\S]*?\n}\n\nstatic int flash_word/);
if (!programMode || !programMode[0].includes('FLASH_CR_PG | FLASH_CR_PSIZE_32')) {
  throw new Error('Program mode must set FLASH_CR.PG with 32-bit PSIZE');
}
const cacheFlush = source.match(/static void flush_flash_caches\([\s\S]*?\n}/);
if (!cacheFlush
  || !cacheFlush[0].includes('FLASH_ACR_ICRST')
  || !cacheFlush[0].includes('FLASH_ACR_DCRST')) {
  throw new Error('Flash Algorithm must invalidate STM32F4 instruction and data caches after erase/program');
}
const eraseBody = source.match(/int EraseSector\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.programPage"/);
const programBody = source.match(/int ProgramPage\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.verify"/);
if (!eraseBody?.[0].includes('flush_flash_caches()')
  || !programBody?.[0].includes('flush_flash_caches()')) {
  throw new Error('Successful erase and program operations must invalidate stale Flash cache lines before Verify');
}

const image = fs.readFileSync(imagePath);
if (image.length <= bkptOffset + 1) {
  throw new Error(`Flash Algorithm image is too small: ${image.length} bytes`);
}

for (const offset of entryOffsets) {
  if ((image[offset] | image[offset + 1]) === 0) {
    throw new Error(`Flash Algorithm entry at 0x${offset.toString(16)} is empty`);
  }
}

if (image[bkptOffset] !== 0x00 || image[bkptOffset + 1] !== 0xBE) {
  throw new Error(`Flash Algorithm BKPT sentinel is missing at 0x${bkptOffset.toString(16)}`);
}

const hasOpcode = (opcode) => image.some((value, index) => value === opcode[0] && image[index + 1] === opcode[1]);
if (!hasOpcode([0x72, 0xB6]) || hasOpcode([0x62, 0xB6])) {
  throw new Error('Flash Algorithm image must contain CPSID i and no CPSIE i before BKPT');
}

console.log(`cmsis-dap flash algorithm: ${image.length} bytes, entries=${entryOffsets.map(offset => `0x${offset.toString(16)}`).join(',')}, bkpt=0x${bkptOffset.toString(16)}`);
