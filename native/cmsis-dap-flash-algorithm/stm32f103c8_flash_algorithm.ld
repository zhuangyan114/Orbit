MEMORY
{
  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 20K
}

SECTIONS
{
  .text ORIGIN(RAM) :
  {
    __algorithm_start = .;
    . = ORIGIN(RAM) + 0x000;
    KEEP(*(.text.init))
    ASSERT(. <= ORIGIN(RAM) + 0x100, "Init entry exceeds its slot");
    . = ORIGIN(RAM) + 0x100;
    KEEP(*(.text.uninit))
    ASSERT(. <= ORIGIN(RAM) + 0x200, "UnInit entry exceeds its slot");
    . = ORIGIN(RAM) + 0x200;
    KEEP(*(.text.eraseSector))
    ASSERT(. <= ORIGIN(RAM) + 0x300, "EraseSector entry exceeds its slot");
    . = ORIGIN(RAM) + 0x300;
    KEEP(*(.text.programPage))
    ASSERT(. <= ORIGIN(RAM) + 0x400, "ProgramPage entry exceeds its slot");
    . = ORIGIN(RAM) + 0x400;
    KEEP(*(.text.verify))
    ASSERT(. <= ORIGIN(RAM) + 0x500, "Verify entry exceeds its slot");
    . = ORIGIN(RAM) + 0x500;
    KEEP(*(.text.bkpt))
    ASSERT(. <= ORIGIN(RAM) + 0x510, "BKPT sentinel exceeds its slot");
    . = ORIGIN(RAM) + 0x600;
    KEEP(*(.text.eraseChip))
    ASSERT(. <= ORIGIN(RAM) + 0x700, "EraseChip entry exceeds its slot");
    *(.text*)
    *(.rodata*)
    . = ALIGN(4);
    __algorithm_end = .;
  } > RAM
  /DISCARD/ :
  {
    *(.comment)
    *(.note*)
    *(.eh_frame*)
    *(.ARM.exidx*)
    *(.ARM.attributes)
  }
}

/* Reserve a 1 KiB upload buffer and 4 KiB stack in the same 20 KiB SRAM. */
ASSERT(__algorithm_end <= ORIGIN(RAM) + 0x3C00, "Flash Algorithm leaves no buffer/stack room");
