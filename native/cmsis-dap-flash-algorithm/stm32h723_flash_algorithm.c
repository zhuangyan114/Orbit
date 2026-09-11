#include <stdint.h>

/*
 * Orbit's CMSIS-DAP Flash Algorithm for the STM32H723VGT6 1 MiB Flash window
 * used by DAP-02A. Source-built like the STM32F407 loader: no startup code,
 * libc, vector table, or external algorithm blob. Register facts verified
 * against ST cmsis-device-h7 stm32h723xx.h and the STM32H7 HAL flash driver
 * (RM0468 family). See docs/cmsis-dap-flash-algorithm-references.md.
 */

#define FLASH_BASE 0x08000000u
#define FLASH_END 0x08100000u
#define FLASH_REG_BASE 0x52002000u

/* H7 single-bank layout: CR1/SR1 sit at swapped offsets relative to STM32F4
 * and error/EOP flags clear through CCR1 write-1 bits, not through SR. */
#define FLASH_ACR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x00u))
#define FLASH_KEYR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x04u))
#define FLASH_CR1 (*(volatile uint32_t *)(FLASH_REG_BASE + 0x0Cu))
#define FLASH_SR1 (*(volatile uint32_t *)(FLASH_REG_BASE + 0x10u))
#define FLASH_CCR1 (*(volatile uint32_t *)(FLASH_REG_BASE + 0x14u))

#define FLASH_CR1_LOCK (1u << 0)
#define FLASH_CR1_PG (1u << 1)
#define FLASH_CR1_SER (1u << 2)
#define FLASH_CR1_PSIZE_MASK (3u << 4)
/* 64-bit erase parallelism for the 2.7-3.6V range (RM0468); revisit only
 * against real-hardware evidence, never silently downgrade. */
#define FLASH_CR1_PSIZE_64 (3u << 4)
#define FLASH_CR1_START (1u << 7)
#define FLASH_CR1_SNB_MASK (7u << 8)

#define FLASH_SR1_BSY (1u << 0)
#define FLASH_SR1_WBNE (1u << 1)
#define FLASH_SR1_QW (1u << 2)
#define FLASH_SR1_EOP (1u << 16)
#define FLASH_SR1_WRPERR (1u << 17)
#define FLASH_SR1_PGSERR (1u << 18)
#define FLASH_SR1_STRBERR (1u << 19)
#define FLASH_SR1_INCERR (1u << 21)
#define FLASH_SR1_OPERR (1u << 22)
#define FLASH_SR1_RDPERR (1u << 23)
#define FLASH_SR1_RDSERR (1u << 24)
#define FLASH_SR1_SNECCERR (1u << 25)
#define FLASH_SR1_DBECCERR (1u << 26)
#define FLASH_SR1_CRCRDERR (1u << 28)
#define FLASH_SR1_ERROR_MASK                                     \
  (FLASH_SR1_WRPERR | FLASH_SR1_PGSERR | FLASH_SR1_STRBERR |     \
   FLASH_SR1_INCERR | FLASH_SR1_OPERR | FLASH_SR1_RDPERR |       \
   FLASH_SR1_RDSERR | FLASH_SR1_SNECCERR | FLASH_SR1_DBECCERR |  \
   FLASH_SR1_CRCRDERR)
#define FLASH_CCR1_CLEAR (FLASH_SR1_EOP | FLASH_SR1_ERROR_MASK)

/* STM32H723 Flash programs 256-bit (32-byte) flash words. The host may hand
 * us any page boundaries; this loader pads outward to whole flash words with
 * the current Flash content, which is 0xFF on erased sectors. */
#define FLASH_WORD_BYTES 32u
#define FLASH_WORD_WORDS 8u

/* The H723 FLASH_ACR has no STM32F4-style ICRST/DCRST bits; the Cortex-M7
 * L1 caches are invalidated through the ARMv7-M maintenance registers. */
#define SCB_CCSIDR (*(volatile uint32_t *)0xE000ED80u)
#define SCB_CSSELR (*(volatile uint32_t *)0xE000ED84u)
#define SCB_ICIALLU (*(volatile uint32_t *)0xE000EF50u)
#define SCB_DCISW (*(volatile uint32_t *)0xE000EF60u)

/* Sized so a 128 KiB sector erase (~2 s worst case) cannot spuriously time
 * out at 550 MHz while the host-side per-operation timeout stays the outer
 * bound on a genuine controller hang. */
#define FLASH_TIMEOUT_LOOPS 0x40000000u

#define FLASH_KEY1 0x45670123u
#define FLASH_KEY2 0xCDEF89ABu

static void mask_interrupts(void) {
  // Flash erase/program cannot safely service an ISR fetched from Flash.
  // Keep interrupts masked through the algorithm return-to-BKPT path.
  __asm volatile("cpsid i" ::: "memory");
}

static int in_flash(uint32_t address, uint32_t size) {
  return address >= FLASH_BASE && address <= FLASH_END && size <= FLASH_END - address;
}

static uint32_t error_code(uint32_t status) {
  return (status & (FLASH_SR1_WRPERR | FLASH_SR1_RDPERR)) != 0u ? 2u : 3u;
}

static void clear_status(void) {
  FLASH_CCR1 = FLASH_CCR1_CLEAR;
}

static int wait_ready(void) {
  volatile uint32_t countdown = FLASH_TIMEOUT_LOOPS;
  while (countdown-- != 0u) {
    const uint32_t status = FLASH_SR1;
    if ((status & (FLASH_SR1_BSY | FLASH_SR1_WBNE | FLASH_SR1_QW)) == 0u) {
      return (status & FLASH_SR1_ERROR_MASK) != 0u ? (int)error_code(status) : 0;
    }
  }
  return 1;
}

static int wait_busy(void) {
  volatile uint32_t countdown = FLASH_TIMEOUT_LOOPS;
  while (countdown-- != 0u) {
    if ((FLASH_SR1 & (FLASH_SR1_BSY | FLASH_SR1_WBNE | FLASH_SR1_QW)) == 0u) return 0;
  }
  return 1;
}

static int unlock_flash(void) {
  if ((FLASH_CR1 & FLASH_CR1_LOCK) != 0u) {
    FLASH_KEYR = FLASH_KEY1;
    FLASH_KEYR = FLASH_KEY2;
  }
  return (FLASH_CR1 & FLASH_CR1_LOCK) != 0u ? 2 : 0;
}

static void clear_mode(void) {
  FLASH_CR1 &= ~(FLASH_CR1_PG | FLASH_CR1_SER | FLASH_CR1_SNB_MASK | FLASH_CR1_PSIZE_MASK);
}

static void invalidate_target_caches(void) {
  // Both L1 caches may hold pre-erase/program Flash lines from the halted
  // firmware. The M7 has no ACR reset bits, so invalidate I-cache wholesale
  // and D-cache by set/way before any read-back verification.
  __asm volatile("dsb" ::: "memory");
  __asm volatile("isb" ::: "memory");
  SCB_ICIALLU = 0u;
  __asm volatile("dsb" ::: "memory");
  __asm volatile("isb" ::: "memory");
  SCB_CSSELR = 0u;
  __asm volatile("dsb" ::: "memory");
  const uint32_t ccsidr = SCB_CCSIDR;
  const uint32_t sets = (ccsidr >> 13) & 0x7FFFu;
  const uint32_t ways = (ccsidr >> 3) & 0x3FFu;
  for (uint32_t way = 0u; way <= ways; ++way) {
    for (uint32_t set = 0u; set <= sets; ++set) {
      SCB_DCISW = (way << 30) | (set << 5);
    }
  }
  __asm volatile("dsb" ::: "memory");
  __asm volatile("isb" ::: "memory");
}

static int sector_number(uint32_t address) {
  if (address < FLASH_BASE || address >= FLASH_END) return -1;
  // 8 uniform 128 KiB sectors; only exact sector starts are accepted.
  if ((address & 0x1FFFFu) != 0u) return -1;
  return (int)((address - FLASH_BASE) >> 17);
}

// noinline: single-call-site statics would otherwise be inlined into the
// fixed 0x100 entry slots and overflow the linker layout.
__attribute__((noinline)) static int flash_word(uint32_t address, const uint32_t *words) {
  uint32_t current[FLASH_WORD_WORDS];
  int identical = 1;
  for (uint32_t index = 0u; index < FLASH_WORD_WORDS; ++index) {
    current[index] = *(volatile uint32_t *)(address + index * 4u);
    if ((words[index] & ~current[index]) != 0u) return 3;
    if (words[index] != current[index]) identical = 0;
  }
  if (identical) return 0;
  FLASH_CR1 |= FLASH_CR1_PG;
  __asm volatile("isb" ::: "memory");
  __asm volatile("dsb" ::: "memory");
  for (uint32_t index = 0u; index < FLASH_WORD_WORDS; ++index) {
    *(volatile uint32_t *)(address + index * 4u) = words[index];
  }
  __asm volatile("isb" ::: "memory");
  __asm volatile("dsb" ::: "memory");
  const int result = wait_ready();
  FLASH_CR1 &= ~FLASH_CR1_PG;
  return result;
}

__attribute__((noinline)) static int program_word(uint32_t wordAddress, uint32_t adr, uint32_t end,
                        const uint8_t *source) {
  uint32_t words[FLASH_WORD_WORDS];
  for (uint32_t index = 0u; index < FLASH_WORD_WORDS; ++index) {
    const uint32_t wordStart = wordAddress + index * 4u;
    uint32_t value = *(volatile uint32_t *)wordStart;
    for (uint32_t byte = 0u; byte < 4u; ++byte) {
      const uint32_t address = wordStart + byte;
      if (address >= adr && address < end) {
        const uint32_t shift = byte * 8u;
        value = (value & ~(0xFFu << shift)) |
                ((uint32_t)source[address - adr] << shift);
      }
    }
    words[index] = value;
  }
  return flash_word(wordAddress, words);
}

__attribute__((section(".text.init"), noinline, used))
int Init(uint32_t adr, uint32_t clk, uint32_t fnc) {
  mask_interrupts();
  (void)adr;
  (void)clk;
  (void)fnc;
  if (wait_busy() != 0) return 1;
  clear_status();
  return unlock_flash();
}

__attribute__((section(".text.uninit"), noinline, used))
int UnInit(uint32_t fnc) {
  (void)fnc;
  clear_mode();
  FLASH_CR1 |= FLASH_CR1_LOCK;
  return 0;
}

__attribute__((section(".text.eraseSector"), noinline, used))
int EraseSector(uint32_t adr) {
  mask_interrupts();
  const int sector = sector_number(adr);
  if (sector < 0) return 3;
  if (wait_busy() != 0) return 1;
  clear_status();
  const int unlock_result = unlock_flash();
  if (unlock_result != 0) return unlock_result;
  FLASH_CR1 = (FLASH_CR1 & ~(FLASH_CR1_PG | FLASH_CR1_SER | FLASH_CR1_SNB_MASK |
                             FLASH_CR1_PSIZE_MASK)) |
              FLASH_CR1_SER | FLASH_CR1_PSIZE_64 | ((uint32_t)sector << 8);
  FLASH_CR1 |= FLASH_CR1_START;
  const int result = wait_ready();
  clear_mode();
  if (result != 0) return result;
  const uint32_t status = FLASH_SR1;
  if ((status & FLASH_SR1_ERROR_MASK) != 0u) return (int)error_code(status);
  invalidate_target_caches();
  return 0;
}

__attribute__((section(".text.programPage"), noinline, used))
int ProgramPage(uint32_t adr, uint32_t sz, uint32_t buf) {
  mask_interrupts();
  if (sz == 0u || sz > 0x10000u || !in_flash(adr, sz)) return 3;
  if (wait_busy() != 0) return 1;
  clear_status();
  const int unlock_result = unlock_flash();
  if (unlock_result != 0) return unlock_result;

  const uint8_t *source = (const uint8_t *)buf;
  const uint32_t end = adr + sz;
  uint32_t wordAddress = adr & ~(FLASH_WORD_BYTES - 1u);
  const uint32_t lastWord = (end + FLASH_WORD_BYTES - 1u) & ~(FLASH_WORD_BYTES - 1u);
  while (wordAddress < lastWord) {
    const int result = program_word(wordAddress, adr, end, source);
    if (result != 0) {
      clear_mode();
      return result;
    }
    wordAddress += FLASH_WORD_BYTES;
  }
  clear_mode();
  const uint32_t status = FLASH_SR1;
  if ((status & FLASH_SR1_ERROR_MASK) != 0u) return (int)error_code(status);
  invalidate_target_caches();
  return 0;
}

__attribute__((section(".text.verify"), noinline, used))
int Verify(uint32_t adr, uint32_t sz, uint32_t buf) {
  mask_interrupts();
  if (sz == 0u || !in_flash(adr, sz)) return 3;
  const uint8_t *source = (const uint8_t *)buf;
  uint32_t offset = 0u;
  // H7 ECC Flash faults on byte/halfword instruction fetches and data reads
  // when ART/I-cache is off (typical of a RAM flash loader). Compare 32-bit
  // words, then the leftover tail through a word load plus shift.
  while (offset + 4u <= sz) {
    uint32_t expected = (uint32_t)source[offset]
                      | ((uint32_t)source[offset + 1u] << 8)
                      | ((uint32_t)source[offset + 2u] << 16)
                      | ((uint32_t)source[offset + 3u] << 24);
    if (*(volatile const uint32_t *)(adr + offset) != expected) return 3;
    offset += 4u;
  }
  if (offset < sz) {
    const uint32_t wordAddress = (adr + offset) & ~3u;
    const uint32_t word = *(volatile const uint32_t *)wordAddress;
    while (offset < sz) {
      const uint32_t shift = ((adr + offset) & 3u) * 8u;
      if (((word >> shift) & 0xFFu) != source[offset]) return 3;
      offset += 1u;
    }
  }
  return 0;
}

__attribute__((section(".text.bkpt"), noinline, used))
void FlashAlgorithmBkpt(void) {
  __asm volatile("bkpt #0");
  for (;;) {
  }
}
