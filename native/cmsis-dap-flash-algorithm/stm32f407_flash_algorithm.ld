MEMORY
{
  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
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

ASSERT(__algorithm_end <= ORIGIN(RAM) + 0x10000, "Flash Algorithm exceeds the loader image limit");
