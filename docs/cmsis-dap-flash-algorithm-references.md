# DAP-02A Flash Algorithm References

This file records the references used for DAP-02A. The implementation does
not vendor an FLM from a CMSIS-Pack, OpenOCD, or pyOCD distribution. The
STM32F407 and STM32H723 images are compiled from the original sources in
`native/cmsis-dap-flash-algorithm/`.

## References

| Reference | Version or access point | License / redistribution judgment | Used for |
| --- | --- | --- | --- |
| ARM CMSIS-Pack Flash Algorithm specification | Open-CMSIS-Pack specification `main`, accessed 2026-08-04: https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/flashAlgorithm.html | Open-CMSIS-Pack specification repository is Apache-2.0. The specification is documentation, not a redistributable target algorithm image. | `Init`, `UnInit`, `EraseSector`, `ProgramPage`, and `Verify` ABI; R0-R3 argument convention; RAM algorithm and breakpoint completion model. |
| ARM CMSIS-DAP specification and command documentation | CMSIS-DAP latest documentation, accessed 2026-08-04: https://arm-software.github.io/CMSIS-DAP/latest/ | CMSIS-DAP documentation and protocol definitions are used as standards references only; no ARM binary or implementation source is copied. | SWD DP/AP transport, memory access, and the single-owner helper boundary. |
| ST RM0090 | STM32F405/407 reference manual, document DM00031020, current ST PDF at access date: https://www.st.com/resource/en/reference_manual/dm00031020.pdf | ST reference material is not treated as open-source code. No ST source code is copied or redistributed. | STM32F4 Flash registers, keys, status/error bits, sector numbering, 32-bit programming, and erase sequencing. |
| ST RM0468 | STM32H723/733, H725/735, H730 reference manual (accessed through ST's same-origin firmware sources below; the ST PDF is https://www.st.com/resource/en/reference_manual/rm0468-stm32h723733-stm32h725735-and-stm32h730-armbased-32bit-mcus-stmicroelectronics.pdf) | ST reference material is not treated as open-source code. No ST source code is copied or redistributed. | STM32H723 Flash organization (8 x 128 KiB sectors, 256-bit flash word), register map, bitfields, and erase/program sequencing. |
| ST cmsis-device-h7 `stm32h723xx.h` | GitHub `STMicroelectronics/cmsis-device-h7` `master`, blob `0507a00` (Include/stm32h723xx.h), accessed 2026-08-23 | ST repository is BSD-3-Clause. Used as a register-facts reference (register offsets, bit masks, memory map); no ST source code is copied into the algorithm. | FLASH_TypeDef layout (ACR 0x00, KEYR1 0x04, CR1 0x0C, SR1 0x10, CCR1 0x14), CR1/SR1/CCR1 bit positions, DBGMCU base 0x5C001000, Flash size register 0x1FF1E880, AXI SRAM map, `FLASH_NB_32BITWORD_IN_FLASHWORD = 8`. |
| ST stm32h7xx-hal-driver flash sources | GitHub `STMicroelectronics/stm32h7xx-hal-driver` `master`, blobs `aea21f4` (Src/stm32h7xx_hal_flash_ex.c), `6154a95` (Src/stm32h7xx_hal_flash.c), `a4773b5` (Inc/stm32h7xx_hal_flash.h), accessed 2026-08-23 | ST repository is BSD-3-Clause. Used as a sequencing reference only; the Orbit algorithm is an independent implementation and copies no ST code. | Unlock via KEYR1 (0x45670123/0xCDEF89AB), erase = SER + SNB(bit 8) + PSIZE + START, program = PG + 8 x 32-bit writes + ISB/DSB, completion polled on QW, errors/EOP cleared via CCR1 write-1 bits, error flag set. |
| OpenOCD `stm32h7x.c` / `stm32h7x.cfg` | OpenOCD `master`, GPL-2.0-or-later: https://github.com/openocd-org/openocd/blob/master/tcl/target/stm32h7x.cfg | GPL code is reference-only and is not copied, translated, linked, or used at runtime. Orbit does not ship OpenOCD or an OpenOCD loader. | Cross-check that DBGMCU DEV_ID `0x483` identifies the RM0468 device family. |
| OpenOCD `stm32f2x.c` and STM32 loader sources | OpenOCD `0.12.0`, GPL-2.0-or-later: https://github.com/openocd-org/openocd/tree/v0.12.0/src/flash/nor and https://github.com/openocd-org/openocd/tree/v0.12.0/contrib/loaders/flash/stm32 | GPL code is reference-only and is not copied, translated, linked, or used at runtime. Orbit does not ship OpenOCD or an OpenOCD loader. | Target/sector identification, bounded wait/error handling, and the conceptual RAM-loader lifecycle. |
| pyOCD FlashAlgo model | pyOCD `0.36.0`, Apache-2.0: https://github.com/pyocd/pyOCD/tree/v0.36.0/pyocd/flash | Apache-2.0 permits reference to the project, but no pyOCD source or algorithm image is bundled. | RAM placement, page-buffer ownership, operation timeout boundaries, and algorithm verify as the preferred path. |

## STM32H723 verified facts (2026-08-25)

Register facts verified against the ST sources above. CMSIS-DAP hardware
acceptance P7-1 through P7-5 ran on STM32H723VGT6 with CMSIS-DAP_LU
(VID `C251` PID `F001` serial `LU_2022_8888`, HID). J-Link P7-6 ran on the
same board with a J-Link (V9.56, VID `1366` PID `0101`, S/N `000164000406`).
Evidence JSON is in `outputs/h723-p7/`. Long-run disconnect (P7-7) is
deferred.

| Fact | Value | Status |
| --- | --- | --- |
| Flash register base | `0x52002000` (D1 AHB1 + 0x2000) | verified vs `stm32h723xx.h` |
| KEYR / CR1 / SR1 / CCR1 offsets | `+0x04` / `+0x0C` / `+0x10` / `+0x14` (CR/SR swapped vs STM32F4) | verified vs `stm32h723xx.h` |
| Unlock keys | `0x45670123` then `0xCDEF89AB` into KEYR1 | verified vs HAL driver |
| CR1 bits | LOCK b0, PG b1, SER b2, PSIZE[5:4], START b7, SNB[10:8] | verified vs `stm32h723xx.h` |
| SR1 bits | BSY b0, WBNE b1, QW b2, EOP b16, WRPERR b17, PGSERR b18, STRBERR b19, INCERR b21, OPERR b22, RDPERR b23, RDSERR b24, SNECCERR b25, DBECCERR b26, CRCEND b27, CRCRDERR b28 | verified vs `stm32h723xx.h` |
| Status/error clearing | write-1 to CCR1 mirror bits (not SR) | verified vs HAL driver |
| Erase sequence | SER + PSIZE + SNB<<8 + START, poll QW, clear SER/SNB | verified vs HAL driver |
| Program sequence | PG + 8 consecutive 32-bit writes (256-bit flash word) + ISB/DSB, poll QW, clear PG | verified vs HAL driver |
| Erase PSIZE | 64-bit (PSIZE=0b11) | verified on hardware P7-4 (last 128 KiB sector erase ~1.11 s) |
| Sector map | 8 x 128 KiB, sector = (addr - 0x08000000) >> 17 | verified on hardware P7-4 (sector 7 @ `0x080E0000`) |
| DBGMCU_IDCODE | `0x5C001000`, DEV_ID `0x483` (this board `0x10016483`) | verified on hardware P7-1 |
| Flash size register | `0x1FF1E880`, 16-bit KiB | verified on hardware P7-1 (1024 KiB) |
| Cache invalidation | Cortex-M7 maintenance registers: ICIALLU (`0xE000EF50`) + DCISW by set/way (`0xE000EF60`); H7 ACR has no ICRST/DCRST bits | verified vs `stm32h723xx.h` ACR definition; P7-4/P7-5 Verify passed |
| SW-DP DPIDR | `0x6BA02477` | verified on hardware P7-1 |
| Sector erase / program timing | last-sector erase ~1.11 s; 32-byte program ~0.27 s; 21844-byte ELF program ~2.5 s. Host defaults remain erase 30 s / program 15 s | measured on hardware P7-4/P7-5 |
| AXI SRAM DAP write | `0x24000100` write/readback restored | verified on hardware P7-2 |
| DTCM / D2 / D3 DAP write | DTCM `0x20000100`, SRAM1-3 `0x30000000`, SRAM4 `0x38000000` write/readback restored | verified on hardware P7-2 |
| CMSIS-DAP ELF flash | `h7vgt6_test.elf` via `flashBeforeDebug: true`, owner=`cmsis-dap`, no J-Link fallback | verified on hardware P7-5 |
| J-Link owner path | `h7vgt6_test.elf`, `device: STM32H723VG` via `JLink.exe` Commander, owner=`jlink-native` only; DPIDR `0x6BA02477`, VTref 3.285 V, connect+flash+entry-stop ~2.4 s | verified on hardware P7-6 (2026-09-11) |
| J-Link device database | J-Link V9.56 has no `STM32H723VGT6`; Commander reports the name as unknown, falls back to `STM32H723VG` and can stall on a device-selection dialog. Use `STM32H723VG` for `probe: "jlink"` | observed on hardware P7-6 |
| Long-run / disconnect | sampling unplug / helper crash | deferred (P7-7) |

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

The selected implementation is a clean-room, source-built loader family:
STM32F407VET6 (512 KiB Flash) and STM32H723VGT6 (1 MiB Flash). It is
deliberately narrower than a general CMSIS-Pack engine. A future user-provided
Pack/FLM can be accepted via `cmsisDapFlashAlgorithmPath`, but an algorithm
with unknown redistribution rights is rejected rather than embedded.
