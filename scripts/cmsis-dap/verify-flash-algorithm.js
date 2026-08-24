'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const entryOffsets = [0x000, 0x100, 0x200, 0x300, 0x400];
const bkptOffset = 0x500;

/**
 * Source-level assertions per algorithm. Each algorithm keeps its own
 * independent contract so a shared regression mistake on one target cannot
 * silently weaken the other target's checks.
 */
function verifyF407Source(source) {
  const initBody = source.match(/int Init\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.uninit"/);
  if (!initBody || !initBody[0].includes('wait_busy()') || initBody[0].includes('wait_ready()')) {
    throw new Error('Init must wait for BSY only, clear stale status flags, and then unlock Flash');
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
}

function verifyH723Source(source) {
  // H7 single-bank register map (RM0468): CR1/SR1 sit at swapped offsets
  // relative to STM32F4 and errors clear through CCR1, not SR.
  for (const required of [
    '#define FLASH_REG_BASE 0x52002000u',
    '#define FLASH_KEYR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x04u))',
    '#define FLASH_CR1 (*(volatile uint32_t *)(FLASH_REG_BASE + 0x0Cu))',
    '#define FLASH_SR1 (*(volatile uint32_t *)(FLASH_REG_BASE + 0x10u))',
    '#define FLASH_CCR1 (*(volatile uint32_t *)(FLASH_REG_BASE + 0x14u))',
    '#define FLASH_KEY1 0x45670123u',
    '#define FLASH_KEY2 0xCDEF89ABu',
  ]) {
    if (!source.includes(required)) {
      throw new Error(`STM32H723 Flash Algorithm register map is wrong: expected ${required}`);
    }
  }
  const initBody = source.match(/int Init\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.uninit"/);
  if (!initBody || !initBody[0].includes('wait_busy()') || initBody[0].includes('wait_ready()')) {
    throw new Error('STM32H723 Init must wait for the wait queue only, clear stale status flags via CCR1, and then unlock Flash');
  }
  const waits = source.match(/static int wait_ready\([\s\S]*?\n}\n\nstatic int wait_busy/);
  if (!waits || !waits[0].includes('FLASH_SR1_BSY | FLASH_SR1_WBNE | FLASH_SR1_QW')) {
    throw new Error('STM32H723 completion waits must poll BSY, WBNE, and QW before checking error flags');
  }
  const sectorNumber = source.match(/static int sector_number\([\s\S]*?\n}/);
  if (!sectorNumber
    || !sectorNumber[0].includes('0x1FFFFu')
    || !sectorNumber[0].includes('>> 17')) {
    throw new Error('STM32H723 sector mapping must use the 128 KiB sector grid (8 uniform sectors, exact starts)');
  }
  const eraseBody = source.match(/int EraseSector\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.programPage"/);
  if (!eraseBody
    || !eraseBody[0].includes('FLASH_CR1_SER | FLASH_CR1_PSIZE_64')
    || !eraseBody[0].includes('<< 8')
    || !eraseBody[0].includes('FLASH_CR1_START')
    || !eraseBody[0].includes('invalidate_target_caches()')) {
    throw new Error('STM32H723 erase must request SER with 64-bit PSIZE, program SNB at bit 8, trigger START, and invalidate caches after success');
  }
  const programBody = source.match(/int ProgramPage\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.verify"/);
  if (!programBody
    || !programBody[0].includes('FLASH_WORD_BYTES - 1u')
    || !programBody[0].includes('invalidate_target_caches()')) {
    throw new Error('STM32H723 program must pad pages outward to whole 256-bit flash words and invalidate caches after success');
  }
  const flashWord = source.match(/__attribute__\(\(noinline\)\) static int flash_word\([\s\S]*?\n}/);
  if (!flashWord
    || !flashWord[0].includes('FLASH_CR1_PG')
    || !flashWord[0].includes('FLASH_WORD_WORDS')) {
    throw new Error('STM32H723 flash word programming must set PG and write all eight 32-bit words of the 256-bit row');
  }
  const verifyBody = source.match(/int Verify\([\s\S]*?\n}\n\n__attribute__\(\(section\("\.text\.bkpt"/);
  if (!verifyBody
    || !verifyBody[0].includes('volatile const uint32_t')
    || verifyBody[0].includes('volatile const uint8_t')) {
    throw new Error('STM32H723 Verify must compare Flash through 32-bit loads; byte reads fault on ECC Flash with ART/I-cache off');
  }
  const cacheInvalidate = source.match(/static void invalidate_target_caches\([\s\S]*?\n}\n\nstatic int sector_number/);
  if (!cacheInvalidate
    || !cacheInvalidate[0].includes('SCB_ICIALLU')
    || !cacheInvalidate[0].includes('SCB_DCISW')
    || cacheInvalidate[0].includes('FLASH_ACR_ICRST')) {
    throw new Error('STM32H723 cache invalidation must use the Cortex-M7 maintenance registers (ICIALLU/DCISW), not F4-style ACR reset bits');
  }
}

const algorithms = [
  {
    name: 'stm32f407',
    binaryFile: 'orbit-stm32f407-flash-algorithm.bin',
    sourceFile: 'stm32f407_flash_algorithm.c',
    verifySource: verifyF407Source,
  },
  {
    name: 'stm32h723',
    binaryFile: 'orbit-stm32h723-flash-algorithm.bin',
    sourceFile: 'stm32h723_flash_algorithm.c',
    verifySource: verifyH723Source,
  },
];

for (const algorithm of algorithms) {
  const imagePath = path.join(repositoryRoot, 'out', 'native', 'win32-x64', algorithm.binaryFile);
  const sourcePath = path.join(repositoryRoot, 'native', 'cmsis-dap-flash-algorithm', algorithm.sourceFile);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Flash Algorithm image is missing: ${imagePath}`);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Flash Algorithm source is missing: ${sourcePath}`);
  }

  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!source.includes('cpsid i') || source.includes('cpsie i')) {
    throw new Error('Flash Algorithm must keep interrupts masked through the RAM return-to-BKPT path');
  }
  algorithm.verifySource(source);

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

  console.log(`cmsis-dap flash algorithm (${algorithm.name}): ${image.length} bytes, entries=${entryOffsets.map(offset => `0x${offset.toString(16)}`).join(',')}, bkpt=0x${bkptOffset.toString(16)}`);
}
