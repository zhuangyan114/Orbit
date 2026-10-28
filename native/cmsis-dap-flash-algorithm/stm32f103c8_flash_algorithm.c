#include <stdint.h>

/*
 * Original MIT-licensed STM32F103C8T6 RAM loader, built for Cortex-M3.
 * Register facts/sequences: PM0075 Rev 2 sections 2.3 and 3; RM0008 RCC.
 * Only the documented 64 KiB main Flash is supported. No option-byte writes,
 * vendor source or third-party algorithm image is included. RMLink adds a
 * guarded whole-declared-main-Flash erase; partial images use EraseSector.
 */
#define FLASH_BASE 0x08000000u
#define FLASH_END 0x08010000u
#define FLASH_PAGE_BYTES 0x400u
#define FLASH_REG_BASE 0x40022000u
#define FLASH_KEYR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x04u))
#define FLASH_SR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x0Cu))
#define FLASH_CR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x10u))
#define FLASH_AR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x14u))
#define FLASH_WRPR (*(volatile uint32_t *)(FLASH_REG_BASE + 0x20u))
#define RCC_CR (*(volatile uint32_t *)0x40021000u)
#define RCC_CR_HSION (1u << 0)
#define RCC_CR_HSIRDY (1u << 1)
#define FLASH_SR_BSY (1u << 0)
#define FLASH_SR_PGERR (1u << 2)
#define FLASH_SR_WRPRTERR (1u << 4)
#define FLASH_SR_EOP (1u << 5)
#define FLASH_SR_ERROR_MASK (FLASH_SR_PGERR | FLASH_SR_WRPRTERR)
#define FLASH_CR_PG (1u << 0)
#define FLASH_CR_PER (1u << 1)
#define FLASH_CR_MER (1u << 2)
#define FLASH_CR_STRT (1u << 6)
#define FLASH_CR_LOCK (1u << 7)
/* Clear PG/PER/MER/OPTPG/OPTER/STRT before selecting only PG or PER. */
#define FLASH_CR_MODE_MASK 0x77u
#define FLASH_KEY1 0x45670123u
#define FLASH_KEY2 0xCDEF89ABu
#define FLASH_TIMEOUT_LOOPS 1000000u

static void mask_interrupts(void) {
  __asm volatile("cpsid i" ::: "memory");
}

static int in_flash(uint32_t address, uint32_t size) {
  return address >= FLASH_BASE && address < FLASH_END && size <= FLASH_END - address;
}

__attribute__((noinline)) static int wait_busy(void) {
  volatile uint32_t countdown = FLASH_TIMEOUT_LOOPS;
  while (countdown-- != 0u) {
    if ((FLASH_SR & FLASH_SR_BSY) == 0u) return 0;
  }
  return 1;
}

__attribute__((noinline)) static int wait_ready(void) {
  if (wait_busy() != 0) return 1;
  const uint32_t status = FLASH_SR;
  if ((status & FLASH_SR_WRPRTERR) != 0u) return 2;
  return (status & FLASH_SR_PGERR) != 0u ? 3 : 0;
}

static void clear_status(void) {
  FLASH_SR = FLASH_SR_EOP | FLASH_SR_ERROR_MASK;
}

__attribute__((noinline)) static int unlock_flash(void) {
  if ((FLASH_CR & FLASH_CR_LOCK) != 0u) {
    FLASH_KEYR = FLASH_KEY1;
    FLASH_KEYR = FLASH_KEY2;
  }
  return (FLASH_CR & FLASH_CR_LOCK) != 0u ? 2 : 0;
}

static void clear_mode(void) {
  FLASH_CR &= ~FLASH_CR_MODE_MASK;
}

__attribute__((noinline)) static int enable_hsi(void) {
  // PM0075 section 2: HSI must be on for erase/program. Preserve the system
  // clock, PLL, latency and prefetch settings; leave HSI enabled until reset.
  RCC_CR |= RCC_CR_HSION;
  volatile uint32_t countdown = FLASH_TIMEOUT_LOOPS;
  while (countdown-- != 0u) {
    if ((RCC_CR & RCC_CR_HSIRDY) != 0u) return 0;
  }
  return 1;
}

__attribute__((section(".text.init"), noinline, used))
int Init(uint32_t adr, uint32_t clk, uint32_t fnc) {
  mask_interrupts();
  (void)clk;
  (void)fnc;
  if (!in_flash(adr, 1u)) return 3;
  if (enable_hsi() != 0 || wait_busy() != 0) return 1;
  clear_status();
  return unlock_flash();
}

__attribute__((section(".text.uninit"), noinline, used))
int UnInit(uint32_t fnc) {
  (void)fnc;
  if (wait_busy() != 0) return 1;
  clear_mode();
  FLASH_CR |= FLASH_CR_LOCK;
  return 0;
}

__attribute__((section(".text.eraseSector"), noinline, used))
int EraseSector(uint32_t adr) {
  mask_interrupts();
  if (!in_flash(adr, FLASH_PAGE_BYTES) || (adr & (FLASH_PAGE_BYTES - 1u)) != 0u) return 3;
  if (wait_busy() != 0) return 1;
  clear_status();
  const int unlocked = unlock_flash();
  if (unlocked != 0) return unlocked;
  clear_mode();
  FLASH_CR |= FLASH_CR_PER;
  FLASH_AR = adr;
  FLASH_CR |= FLASH_CR_STRT;
  // ES096 Rev 15 section 2.2.11: BSY rises one cycle after STRT. Complete
  // the register write and delay before polling, even at maximum core speed.
  __asm volatile("dsb\nnop\nnop" ::: "memory");
  const int result = wait_ready();
  // Registers cannot be written while BSY is set (PM0075 section 2.3.3).
  if (result != 1) clear_mode();
  return result;
}

/* PM0075 Rev 2, section 2.3.3: MER erases user pages, not the information block.
 * The F103C8 profile must already have checked identity and declared capacity.
 * Three exact arguments prevent a partial-range call from selecting mass erase.
 */
__attribute__((section(".text.eraseChip"), noinline, used))
int EraseChip(uint32_t adr, uint32_t length, uint32_t guard) {
  mask_interrupts();
  if (adr != FLASH_BASE || length != FLASH_END-FLASH_BASE || guard != 0x524D4C4Bu) return 3;
  if ((FLASH_WRPR & 0xFFFFu) != 0xFFFFu) return 2;
  if (wait_busy() != 0) return 1;
  clear_status();
  const int unlocked=unlock_flash();
  if (unlocked != 0) return unlocked;
  clear_mode();
  FLASH_CR |= FLASH_CR_MER;
  FLASH_CR |= FLASH_CR_STRT;
  __asm volatile("dsb\nnop\nnop" ::: "memory");
  const int result=wait_ready();
  if (result != 1) clear_mode();
  if (result != 0) return result;
  for (uint32_t at=FLASH_BASE; at<FLASH_END; at+=4u)
    if (*(volatile const uint32_t *)at != 0xFFFFFFFFu) return 3;
  return 0;
}

__attribute__((section(".text.programPage"), noinline, used))
int ProgramPage(uint32_t adr, uint32_t sz, uint32_t buf) {
  mask_interrupts();
  if (sz == 0u || sz > 0x10000u || ((adr | sz) & 1u) != 0u || !in_flash(adr, sz)) return 3;
  if (wait_busy() != 0) return 1;
  clear_status();
  const int unlocked = unlock_flash();
  if (unlocked != 0) return unlocked;
  clear_mode();
  FLASH_CR |= FLASH_CR_PG;
  const uint8_t *source = (const uint8_t *)buf;
  int result = 0;
  for (uint32_t offset = 0u; offset < sz; offset += 2u) {
    volatile uint16_t *destination = (volatile uint16_t *)(adr + offset);
    const uint16_t value = (uint16_t)((uint16_t)source[offset] | ((uint16_t)source[offset + 1u] << 8));
    if (*destination == value) continue;
    // FPEC requires an erased halfword, with the documented 0x0000 exception.
    if (*destination != 0xFFFFu && value != 0u) { result = 3; break; }
    *destination = value;
    result = wait_ready();
    if (result != 0) break;
    if (*destination != value) { result = 3; break; }
  }
  if (result != 1) clear_mode();
  return result;
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
  for (;;) {}
}
