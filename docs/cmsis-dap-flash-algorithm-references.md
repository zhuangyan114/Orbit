# DAP-02A Flash Algorithm References

This file records the references used for DAP-02A. The implementation does
not vendor an FLM from a CMSIS-Pack, OpenOCD, or pyOCD distribution. The
STM32F407 image is compiled from the original source in
`native/cmsis-dap-flash-algorithm/`.

## References

| Reference | Version or access point | License / redistribution judgment | Used for |
| --- | --- | --- | --- |
| ARM CMSIS-Pack Flash Algorithm specification | Open-CMSIS-Pack specification `main`, accessed 2026-08-04: https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/flashAlgorithm.html | Open-CMSIS-Pack specification repository is Apache-2.0. The specification is documentation, not a redistributable target algorithm image. | `Init`, `UnInit`, `EraseSector`, `ProgramPage`, and `Verify` ABI; R0-R3 argument convention; RAM algorithm and breakpoint completion model. |
| ARM CMSIS-DAP specification and command documentation | CMSIS-DAP latest documentation, accessed 2026-08-04: https://arm-software.github.io/CMSIS-DAP/latest/ | CMSIS-DAP documentation and protocol definitions are used as standards references only; no ARM binary or implementation source is copied. | SWD DP/AP transport, memory access, and the single-owner helper boundary. |
| ST RM0090 | STM32F405/407 reference manual, document DM00031020, current ST PDF at access date: https://www.st.com/resource/en/reference_manual/dm00031020.pdf | ST reference material is not treated as open-source code. No ST source code is copied or redistributed. | STM32F4 Flash registers, keys, status/error bits, sector numbering, 32-bit programming, and erase sequencing. |
| OpenOCD `stm32f2x.c` and STM32 loader sources | OpenOCD `0.12.0`, GPL-2.0-or-later: https://github.com/openocd-org/openocd/tree/v0.12.0/src/flash/nor and https://github.com/openocd-org/openocd/tree/v0.12.0/contrib/loaders/flash/stm32 | GPL code is reference-only and is not copied, translated, linked, or used at runtime. Orbit does not ship OpenOCD or an OpenOCD loader. | Target/sector identification, bounded wait/error handling, and the conceptual RAM-loader lifecycle. |
| pyOCD FlashAlgo model | pyOCD `0.36.0`, Apache-2.0: https://github.com/pyocd/pyOCD/tree/v0.36.0/pyocd/flash | Apache-2.0 permits reference to the project, but no pyOCD source or algorithm image is bundled. | RAM placement, page-buffer ownership, operation timeout boundaries, and algorithm verify as the preferred path. |

## Architecture decision

Three designs were compared:

1. CMSIS-Pack/RAM algorithm: selected. The host validates the ELF and target
   before erase, places the original algorithm image, stack, and page buffer in
   SRAM, sets the CMSIS-Pack registers, and accepts completion only at the
   trusted BKPT.
2. An OpenOCD-shaped loader: not selected as an implementation source. Its
   GPL-2.0-or-later code cannot be silently copied into this MIT extension, and
   adding OpenOCD as a runtime owner would violate the project's one-owner
   boundary.
3. Host-side register programming: not selected. It would make every Flash
   controller sequencing detail and polling policy part of the host/DAP
   critical path, while still requiring a target-side memory-write primitive.

The selected first implementation is a clean-room, source-built loader for
exactly STM32F407VET6 with 512 KiB Flash. It is deliberately narrower than a
general CMSIS-Pack engine. A future user-provided Pack/FLM can be accepted via
`cmsisDapFlashAlgorithmPath`, but an algorithm with unknown redistribution
rights is rejected rather than embedded.
