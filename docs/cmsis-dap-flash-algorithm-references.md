# DAP-02A Flash Algorithm References

This file records the references used for DAP-02A. The implementation does
not vendor an FLM from a CMSIS-Pack, OpenOCD, or pyOCD distribution. The
STM32F103C8, STM32F407 and STM32H723 images are compiled from the original sources in
`native/cmsis-dap-flash-algorithm/`.

> Note (v1.2.3+): Orbit's native RAM Flash algorithms (`native/cmsis-dap-flash-algorithm/`) remain clean-room MIT implementations with no OpenOCD/GPL code copied. Starting in v1.2.3, Orbit separately bundles the unmodified upstream OpenOCD CLI binary (`resources/openocd/`, `GPL-2.0-or-later`; see `THIRD_PARTY_NOTICES.md`) strictly as an optional standalone programmer process (`src/ozone-backend/openocd-flasher.ts`) before claiming the debug owner.

## References

| Reference | Version or access point | License / redistribution judgment | Used for |
| --- | --- | --- | --- |
| ARM CMSIS-Pack Flash Algorithm specification | Open-CMSIS-Pack specification `main`, accessed 2026-08-04: https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/flashAlgorithm.html | Open-CMSIS-Pack specification repository is Apache-2.0. The specification is documentation, not a redistributable target algorithm image. | `Init`, `UnInit`, `EraseSector`, `ProgramPage`, and `Verify` ABI; R0-R3 argument convention; RAM algorithm and breakpoint completion model. |
| ARM CMSIS-DAP specification and command documentation | CMSIS-DAP latest documentation, accessed 2026-08-04: https://arm-software.github.io/CMSIS-DAP/latest/ | CMSIS-DAP documentation and protocol definitions are used as standards references only; no ARM binary or implementation source is copied. | SWD DP/AP transport, memory access, and the single-owner helper boundary. |
| ST RM0090 | STM32F405/407 reference manual, document DM00031020, current ST PDF at access date: https://www.st.com/resource/en/reference_manual/dm00031020.pdf | ST reference material is not treated as open-source code. No ST source code is copied or redistributed. | STM32F4 Flash registers, keys, status/error bits, sector numbering, 32-bit programming, and erase sequencing. |
| ST RM0468 | STM32H723/733, H725/735, H730 reference manual (accessed through ST's same-origin firmware sources below; the ST PDF is https://www.st.com/resource/en/reference_manual/rm0468-stm32h723733-stm32h725735-and-stm32h730-armbased-32bit-mcus-stmicroelectronics.pdf) | ST reference material is not treated as open-source code. No ST source code is copied or redistributed. | STM32H723 Flash organization (8 x 128 KiB sectors, 256-bit flash word), register map, bitfields, and erase/program sequencing. |
| ST cmsis-device-h7 `stm32h723xx.h` | GitHub `STMicroelectronics/cmsis-device-h7` `master`, blob `0507a00` (Include/stm32h723xx.h), accessed 2026-08-23 | ST repository is BSD-3-Clause. Used as a register-facts reference (register offsets, bit masks, memory map); no ST source code is copied into the algorithm. | FLASH_TypeDef layout (ACR 0x00, KEYR1 0x04, CR1 0x0C, SR1 0x10, CCR1 0x14), CR1/SR1/CCR1 bit positions, DBGMCU base 0x5C001000, Flash size register 0x1FF1E880, AXI SRAM map, `FLASH_NB_32BITWORD_IN_FLASHWORD = 8`. |
| ST stm32h7xx-hal-driver flash sources | GitHub `STMicroelectronics/stm32h7xx-hal-driver` `master`, blobs `aea21f4` (Src/stm32h7xx_hal_flash_ex.c), `6154a95` (Src/stm32h7xx_hal_flash.c), `a4773b5` (Inc/stm32h7xx_hal_flash.h), accessed 2026-08-23 | ST repository is BSD-3-Clause. Used as a sequencing reference only; the Orbit algorithm is an independent implementation and copies no ST code. | Unlock via KEYR1 (0x45670123/0xCDEF89AB), erase = SER + SNB(bit 8) + PSIZE + START, program = PG + 8 x 32-bit writes + ISB/DSB, completion polled on QW, errors/EOP cleared via CCR1 write-1 bits, error flag set. |
| OpenOCD `stm32h7x.c` / `stm32h7x.cfg` | OpenOCD `master`, GPL-2.0-or-later: https://github.com/openocd-org/openocd/blob/master/tcl/target/stm32h7x.cfg | GPL code is reference-only for the native RAM algorithm (`native/cmsis-dap-flash-algorithm/`) and is not copied, translated, or linked into Orbit's MIT code. (v1.2.3+ bundles unmodified upstream OpenOCD separately in `resources/openocd/` only as a standalone CLI programmer.) | Cross-check that DBGMCU DEV_ID `0x483` identifies the RM0468 device family. |
| OpenOCD `stm32f2x.c` and STM32 loader sources | OpenOCD `0.12.0`, GPL-2.0-or-later: https://github.com/openocd-org/openocd/tree/v0.12.0/src/flash/nor and https://github.com/openocd-org/openocd/tree/v0.12.0/contrib/loaders/flash/stm32 | GPL code is reference-only for the native RAM algorithm (`native/cmsis-dap-flash-algorithm/`) and is not copied, translated, or linked into Orbit's MIT code. | Target/sector identification, bounded wait/error handling, and the conceptual RAM-loader lifecycle. |
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
STM32F407VET6 (512 KiB Flash), STM32F407IG (1 MiB Flash), and
STM32H723VGT6 (1 MiB Flash). It is
deliberately narrower than a general CMSIS-Pack engine. A future user-provided
Pack/FLM can be accepted via `cmsisDapFlashAlgorithmPath`, but an algorithm
with unknown redistribution rights is rejected rather than embedded.

## STM32F407IG adaptation (2026-10-02)

The IG density is 1 MiB per [ST's STM32F407IG product page](https://www.st.com/en/microcontrollers-microprocessors/stm32f407ig.html).
RM0090 defines the same F4 controller with twelve sectors: four 16 KiB,
one 64 KiB, and seven 128 KiB, covering `0x08000000–0x080FFFFF`.
The added sectors 8–11 start at `0x08080000`, `0x080A0000`,
`0x080C0000`, and `0x080E0000`. The IG profile uses the existing read-only
preflight registers (`DBGMCU_IDCODE=0xE0042000`, DEV_ID `0x413`, Flash
capacity at `0x1FFF7A22`) and requires 1024 KiB before any algorithm call.
The family ID and capacity do not distinguish package variants or prove an
exact SKU; the configured name must agree with the board/project.

`scripts/build-native.ps1` builds `orbit-stm32f407ig-flash-algorithm.bin`
from Orbit's existing MIT-licensed `stm32f407_flash_algorithm.c` and linker
script with `ORBIT_F407_FLASH_SIZE_KIB=1024`. The original `stm32f407`
image remains a 512 KiB build; sectors 8–11 are excluded from that image.
Both images retain the fixed entry offsets and use the 128 KiB ordinary
SRAM window, keeping the existing exclusion of CCM PT_LOAD segments.
No external binary or vendor source code is embedded. On 2026-10-02 the
user confirmed normal operation on the current IG board/firmware after the
128 KiB sector RAM-validation fix. This is basic user hardware confirmation;
full-sector/bank coverage, additional probes/transports, and long-run/disconnect
acceptance remain unverified. The confirmed fix is recorded in
`docs/bug-fix-log.md`.

## STM32F103C8T6 adaptation (2026-10-06)

This profile registers exactly `STM32F103C8T6` and the project shorthand
`STM32F103C8`. It uses the existing CMSIS-DAP owner, SWD/Cortex-M control,
Flash RPC and scheduler. It does not register F103CB, other packages,
GD32/CS32-compatible parts or undocumented capacity above 64 KiB.

| Reference | Revision / location, accessed 2026-10-06 | Use / license judgment |
| --- | --- | --- |
| [ST STM32F103x8/xB datasheet](https://www.st.com/resource/en/datasheet/stm32f103t8.pdf) | DS5319 Rev 20, Table 2, section 2.3, Flash timing table in section 5.3 | C8: 64 KiB Flash, 20 KiB SRAM, Cortex-M3, 2.0–3.6 V; 1 KiB page erase maximum 40 ms and halfword program maximum 70 us. Documentation facts only; no copied code/image. |
| [ST STM32F1 reference manual](https://www.st.com/resource/de/reference_manual/cd00171190.pdf) | RM0008 Rev 21, embedded Flash, RCC_CR, debug ID and device electronic signature chapters | Medium-density DEV_ID 0x410; Flash size is a 16-bit KiB value at 0x1FFFF7E0. The web reader could not open the full PDF due to its size; addresses/bit definitions were cross-checked against the official CMSIS device header below. |
| [ST Flash programming manual](https://www.st.com/resource/en/programming_manual/pm0075-stm32f10xxx-flash-memory-microcontrollers-stmicroelectronics.pdf) | PM0075 Rev 2, Table 3, sections 2, 2.3.2–2.3.4 and 3 | 1 KiB erase pages, 16-bit main-Flash programming, unlock keys, HSI required, BSY/errors/EOP and register write restrictions. Register/sequencing facts only. |
| [ST device errata](https://www.st.com/resource/en/errata_sheet/es096-stm32f101x8b-stm32f102x8b-and-stm32f103x8b-mediumdensity-device-limitations-stmicroelectronics.pdf) | ES096 Rev 15, section 2.2.11 | BSY rises one cycle after STRT; the SRAM loader inserts DSB and two NOPs before polling. Silicon revision has not been read on a board. |
| [ST CMSIS F103xB device header](https://github.com/STMicroelectronics/cmsis-device-f1/blob/c8e9a4a4f16b6d2cb2a2083cbe5161025280fb22/Include/stm32f103xb.h) | Commit c8e9a4a4f16b6d2cb2a2083cbe5161025280fb22; peripheral map, FLASH_TypeDef and FLASH/RCC bit definitions | Cross-check 0x40022000 FPEC, 0x40021000 RCC, 0xE0042000 DBGMCU and capacity address. Repository [License.md](https://github.com/STMicroelectronics/cmsis-device-f1/blob/c8e9a4a4f16b6d2cb2a2083cbe5161025280fb22/License.md) is Apache-2.0. No ST implementation/header is bundled. |
| [OpenOCD STM32F1 target description](https://github.com/openocd-org/openocd/blob/v0.12.0/tcl/target/stm32f1x.cfg) | v0.12.0, SW-DP ID declaration | Reference-only cross-check of DPIDR 0x1BA01477 for the native RAM algorithm. GPL-2.0-or-later; no code is copied, translated, or linked into Orbit's MIT code. |

| Target/algorithm fact | Value / behavior |
| --- | --- |
| Main Flash | 0x08000000–0x0800FFFF; pages 0–63, each 1024 bytes; last page 0x0800FC00 |
| SRAM / ELF and loader | 0x20000000–0x20004FFF; code at 0x20000000, 4-byte aligned page buffer after code, 4 KiB stack ending at 0x20005000 |
| Preflight | DPIDR 0x1BA01477; DBGMCU at 0xE0042000, DEV_ID 0x410; 0x1FFFF7E0 must report exactly 64 KiB before Init/erase/program |
| FPEC | KEYR +0x04, SR +0x0C, CR +0x10, AR +0x14; SR BSY b0 / PGERR b2 / WRPRTERR b4 / EOP b5; CR PG b0 / PER b1 / STRT b6 / LOCK b7 |
| Programming | 2-byte granularity; merge ELF loads sharing a halfword, then pad odd addresses/tails with erased 0xFF before 1 KiB upload slices; ProgramPage batch limit 64 KiB, further bounded by available loader RAM |
| Protection / clocks | Mask interrupts; enable HSI and wait for ready without changing SYSCLK/PLL/prefetch; never write option bytes or mass erase; UnInit locks FPEC; HSI remains on until reset |
| Timing / failures | Bounded target polling; host erase/program defaults 5 s; return 1 timeout, 2 protection/lock, 3 program/verify/range error; do not write FPEC registers while still busy or replay unknown writes |
| Image / ABI | Original Orbit MIT C source plus linker script, ARM GCC Cortex-M3 / Thumb / soft ABI; entry offsets 0x000/0x100/0x200/0x300/0x400, trusted BKPT at 0x500; no static data (R9/static_base 0), unchanged page buffer for Verify |
| SVD | Existing resolver derives series STM32F103 / pack ID Keil.STM32F1xx_DFP for both names; user-supplied SVD precedence unchanged. Actual Pack/SVD download and Peripheral Viewer have not been verified; no SVD binary is bundled by this adaptation |

Automation covers all page starts, cross-page payloads, the final valid Flash
byte, SRAM/BSS and .data VMA/LMA bounds, halfword merging/padding, identity and
capacity rejection before any algorithm operation, and selected-owner target
resolution. The actual native helper mock uses the built F103 image within
20 KiB RAM to check ABI/layout, first/last-page erase/program/Verify/read-back,
misaligned and out-of-range requests, and stack overflow rejection. The mock
emulates Flash effects; it does not execute the FPEC code on silicon.

Hardware has not been connected or modified for this adaptation. HID and
WinUSB Flash/debug, original chip markings/REV_ID, RAM stub, Init/UnInit,
real ELF verification, Watch/Timeline/RTT, disconnect and long-run behavior
remain pending board acceptance. Use the staged acceptance in
`.agent/skills/cmsis-dap-add-target/references/acceptance.md` with an explicitly
authorized board/ELF and test-page range. Reverting this profile, its optional
host alignment, algorithm source/build entry and tests removes the adaptation;
the existing F407/H723 profiles and their algorithm images remain independent.
