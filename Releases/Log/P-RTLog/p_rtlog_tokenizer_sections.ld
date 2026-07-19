/*
 * P-RTLog linker script snippet for pw_tokenizer sections.
 *
 * These sections are type INFO — they stay in the ELF for host-side
 * decoding tools but are NOT loaded into the target's flash/RAM.
 *
 * Usage (GCC / arm-none-eabi-ld):
 *   Option A: INCLUDE this file in your existing linker script's SECTIONS block.
 *   Option B: Pass -T p_rtlog_tokenizer_sections.ld to the linker (standalone).
 *
 * For Keil / ARM Compiler 6, see p_rtlog_tokenizer_sections.sct instead.
 */

SECTIONS
{
  /*
   * Tokenizer metadata (hash length, integer sizes, etc.)
   * Host-side decoder reads this to know how to decode messages.
   */
  .pw_tokenizer.info 0x0 (INFO) :
  {
    KEEP(*(.pw_tokenizer.info))
  }

  /*
   * Tokenized string entries: each entry contains the original format string
   * and its 32-bit token hash. Host-side tools read these to build the
   * token → string database for decoding.
   *
   * The wildcard .pw_tokenizer.entries.* catches per-string subsections
   * created by -fdata-sections.
   *
   * The .rodata.*_pw_tokenizer_string_entry_* wildcard works around a GCC
   * bug (https://gcc.gnu.org/bugzilla/show_bug.cgi?id=88061) where template
   * variables end up in .rodata instead of the intended section.
   */
  .pw_tokenizer.entries 0x0 (INFO) :
  {
    KEEP(*(.pw_tokenizer.entries.*))
    KEEP(*(.rodata.*_pw_tokenizer_string_entry_*))
  }
}
