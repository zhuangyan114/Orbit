#include <stdint.h>

/*
 * Orbit's first CMSIS-DAP Flash Algorithm is intentionally source-built.
 * It implements only the STM32F407 512 KiB Flash window used by DAP-02A.
 * There is no startup code, libc, vector table, or external algorithm blob.
 */

#define FLASH_BASE 0x08000000u
#define FLASH_END 0x08080000u
#define FLASH_REG_BASE 0x40023C00u

#define FLASH_KEYR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x04u))
#define FLASH_SR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x0Cu))
#define FLASH_CR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x10u))

#define FLASH_SR_EOP (1u << 0)
#define FLASH_SR_OPERR (1u << 1)
#define FLASH_SR_WRPERR (1u << 4)
#define FLASH_SR_PGAERR (1u << 5)
#define FLASH_SR_PGPERR (1u << 6)
#define FLASH_SR_PGSERR (1u << 7)
#define FLASH_SR_RDERR (1u << 8)
#define FLASH_SR_ERROR_MASK \
  (FLASH_SR_OPERR | FLASH_SR_WRPERR | FLASH_SR_PGAERR | FLASH_SR_PGPERR | \
   FLASH_SR_PGSERR | FLASH_SR_RDERR)

#define FLASH_CR_PG (1u << 0)
#define FLASH_CR_SER (1u << 1)
#define FLASH_CR_SNB_MASK (0xFu << 3)
#define FLASH_CR_PSIZE_MASK (3u << 8)
#define FLASH_CR_PSIZE_32 (2u << 8)
#define FLASH_CR_STRT (1u << 16)
#define FLASH_CR_LOCK (1u << 31)

#define FLASH_KEY1 0x45670123u
#define FLASH_KEY2 0xCDEF89ABu

#define FLASH_TIMEOUT_LOOPS 100000000u

static void mask_interrupts(void) {
  // Flash erase/program cannot safely service an ISR fetched from Flash.
  // Keep interrupts masked through the algorithm return-to-BKPT path.
  __asm volatile("cpsid i" ::: "memory");
}

static int in_flash(uint32_t address, uint32_t size) {
  return address >= FLASH_BASE && address <= FLASH_END && size <= FLASH_END - address;
}

static uint32_t error_code(uint32_t status) {
  return (status & FLASH_SR_WRPERR) != 0u ? 2u : 3u;
}

static void clear_status(void) {
  FLASH_SR = FLASH_SR_EOP | FLASH_SR_ERROR_MASK;
}

static int wait_ready(void) {
  volatile uint32_t countdown = FLASH_TIMEOUT_LOOPS;
  while (countdown-- != 0u) {
    const uint32_t status = FLASH_SR;
    if ((status & (1u << 16)) == 0u) {
      return (status & FLASH_SR_ERROR_MASK) != 0u ? (int)error_code(status) : 0;
    }
  }
  return 1;
}

static int wait_busy(void) {
  volatile uint32_t countdown = FLASH_TIMEOUT_LOOPS;
  while (countdown-- != 0u) {
    if ((FLASH_SR & (1u << 16)) == 0u) return 0;
  }
  return 1;
}

static int unlock_flash(void) {
  if ((FLASH_CR & FLASH_CR_LOCK) != 0u) {
    FLASH_KEYR = FLASH_KEY1;
    FLASH_KEYR = FLASH_KEY2;
  }
  return (FLASH_CR & FLASH_CR_LOCK) != 0u ? 2 : 0;
}

static void clear_mode(void) {
  FLASH_CR &= ~(FLASH_CR_PG | FLASH_CR_SER | FLASH_CR_SNB_MASK | FLASH_CR_STRT);
}

static int select_program_mode(void) {
  FLASH_CR = (FLASH_CR & ~(FLASH_CR_PG | FLASH_CR_SER | FLASH_CR_SNB_MASK |
                           FLASH_CR_PSIZE_MASK)) |
             FLASH_CR_PG | FLASH_CR_PSIZE_32;
  return 0;
}

static int flash_word(uint32_t address, uint32_t value) {
  const uint32_t current = *(volatile uint32_t *)address;
  if ((value & ~current) != 0u) return 3;
  if (value == current) return 0;
  *(volatile uint32_t *)address = value;
  return wait_ready();
}

static int sector_number(uint32_t address) {
  if (address == 0x08000000u) return 0;
  if (address == 0x08004000u) return 1;
  if (address == 0x08008000u) return 2;
  if (address == 0x0800C000u) return 3;
  if (address == 0x08010000u) return 4;
  if (address == 0x08020000u) return 5;
  if (address == 0x08040000u) return 6;
  if (address == 0x08060000u) return 7;
  return -1;
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
  FLASH_CR |= FLASH_CR_LOCK;
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
  FLASH_CR = (FLASH_CR & ~(FLASH_CR_PG | FLASH_CR_SER | FLASH_CR_SNB_MASK |
                           FLASH_CR_PSIZE_MASK)) |
             FLASH_CR_SER | ((uint32_t)sector << 3) | FLASH_CR_PSIZE_32;
  FLASH_CR |= FLASH_CR_STRT;
  const int result = wait_ready();
  clear_mode();
  if (result != 0) return result;
  return (FLASH_SR & FLASH_SR_ERROR_MASK) != 0u ? (int)error_code(FLASH_SR) : 0;
}

__attribute__((section(".text.programPage"), noinline, used))
int ProgramPage(uint32_t adr, uint32_t sz, uint32_t buf) {
  mask_interrupts();
  if (sz == 0u || sz > 0x10000u || !in_flash(adr, sz)) return 3;
  if (wait_busy() != 0) return 1;
  clear_status();
  const int unlock_result = unlock_flash();
  if (unlock_result != 0) return unlock_result;
  select_program_mode();

  const uint8_t *source = (const uint8_t *)buf;
  uint32_t wordAddress = adr & ~3u;
  const uint32_t end = adr + sz;
  while (wordAddress < end) {
    uint32_t value = *(volatile uint32_t *)wordAddress;
    const uint32_t wordEnd = wordAddress + 4u;
    for (uint32_t byte = 0u; byte < 4u; ++byte) {
      const uint32_t address = wordAddress + byte;
      if (address >= adr && address < end) {
        const uint32_t shift = byte * 8u;
        value = (value & ~(0xFFu << shift)) |
                ((uint32_t)source[address - adr] << shift);
      }
    }
    if (wordEnd > wordAddress && !in_flash(wordAddress, 4u)) {
      clear_mode();
      return 3;
    }
    const int result = flash_word(wordAddress, value);
    if (result != 0) {
      clear_mode();
      return result;
    }
    wordAddress += 4u;
  }
  const int result = wait_ready();
  clear_mode();
  if (result != 0) return result;
  return (FLASH_SR & FLASH_SR_ERROR_MASK) != 0u ? (int)error_code(FLASH_SR) : 0;
}

__attribute__((section(".text.verify"), noinline, used))
int Verify(uint32_t adr, uint32_t sz, uint32_t buf) {
  mask_interrupts();
  if (sz == 0u || !in_flash(adr, sz)) return 3;
  const uint8_t *source = (const uint8_t *)buf;
  for (uint32_t offset = 0u; offset < sz; ++offset) {
    if (*(volatile const uint8_t *)(adr + offset) != source[offset]) return 3;
  }
  return 0;
}

__attribute__((section(".text.bkpt"), noinline, used))
void FlashAlgorithmBkpt(void) {
  __asm volatile("bkpt #0");
  for (;;) {
  }
}
