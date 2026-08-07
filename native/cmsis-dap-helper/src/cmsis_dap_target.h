#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "cmsis_dap_protocol.h"

namespace cmsis_dap_helper {

class CortexMDebug;

// SW-DP register addresses (the A[3:2] field is addr >> 2).
constexpr uint8_t kDpRegAbortIdcode = 0x00;  // read: IDCODE, write: ABORT
constexpr uint8_t kDpRegCtrlStat = 0x04;
constexpr uint8_t kDpRegSelect = 0x08;
constexpr uint8_t kDpRegRdbuff = 0x0C;

// SW-DP CTRL/STAT sticky bits (ADIv5: bit 5 = SSTICKYERR, bit 1 =
// SSTICKYORUN). These are W1C when written as part of OpenOCD's initial
// CTRL/STAT power-up request.
constexpr uint32_t kCtrlStatStickyErr = 1u << 5;
constexpr uint32_t kCtrlStatStickyOrun = 1u << 1;
constexpr uint32_t kCtrlStatCsyspwrupreq = 1u << 30;
constexpr uint32_t kCtrlStatCsyspwrupack = 1u << 31;
constexpr uint32_t kCtrlStatCdbgpwrupreq = 1u << 28;
constexpr uint32_t kCtrlStatCdbgpwrupack = 1u << 29;
constexpr uint32_t kCtrlStatPowerupRequest = kCtrlStatCsyspwrupreq | kCtrlStatCdbgpwrupreq;
constexpr uint32_t kCtrlStatPowerupAck = kCtrlStatCsyspwrupack | kCtrlStatCdbgpwrupack;

// DP ABORT register write value that clears all sticky flags (ADIv5/OpenOCD:
// STKCMPCLR bit 1 | STKERRCLR bit 2 | WDERRCLR bit 3 | ORUNERRCLR bit 4).
constexpr uint32_t kAbortClearAll = 0x1Eu;

// MEM-AP bank-0 register addresses (the A[3:2] field is addr >> 2).
constexpr uint8_t kApRegCsw = 0x00;
constexpr uint8_t kApRegTar = 0x04;
constexpr uint8_t kApRegDrw = 0x0C;

// OpenOCD's CSW_AHB_DEFAULT fields for an AHB-AP debug transaction:
//   - HPROT1 / privileged access bit  -> bit25
//   - AHB MASTER_DEBUG                 -> bit29
//   - DBGSWENABLE                      -> bit31
// OpenOCD applies this default to every MEM-AP transfer. The STM32F407 AHB-AP
// accepts read-only accesses without these fields, but faults the first
// CoreDebug DRW write when they are omitted.
constexpr uint32_t kApCswAhbHprot1 = 1u << 25;
constexpr uint32_t kApCswAhbMasterDebug = 1u << 29;
constexpr uint32_t kApCswDbgswEnable = 1u << 31;
constexpr uint32_t kApCswAhbDefault =
    kApCswAhbHprot1 | kApCswAhbMasterDebug | kApCswDbgswEnable;

// MEM-AP CSW value for 32-bit single auto-increment transfers, encoded per
// the ADIv5/MEM-AP definition and OpenOCD's AHB debug defaults:
//   - Size    bits[2:0]   = 0b010 (32-bit)     -> 0x02
//   - AddrInc bits[5:4]   = 0b01  (single)     -> 0x10
//   - DeviceEn bit6       = 0: the verified target keeps DeviceEn asserted on
//     its own (the CSW read-back shows bit6=1), so this implementation does
//     not depend on writing it.
//   - AHB debug defaults  = 0xA2000000 (see kApCswAhbDefault above).
// Values that MUST NOT be used (observed on the STM32F407 AHB-AP):
//   - 0x95: Size bits[2:0] = 0b101, a reserved/unsupported Size encoding (not
//     16-bit by itself). The target reads the illegal encoding back as
//     Size=0b001, so every DRW access actually executes as 16-bit and returns
//     a halfword with a stale upper half (e.g. flash word1 read back as
//     0x200001C1 instead of 0x080001C1).
//   - 0x02000095: keeps the same illegal Size bits[2:0] = 0b101 in the low
//     three bits; its upper bits are outside the Size/AddrInc fields and do
//     not change the access width, so it suffers the same 16-bit behavior.
//   - 0x13: Size bits[2:0] = 0b011. Whether 64-bit accesses are supported is
//     a per-MEM-AP capability; the verified target does not accept this
//     encoding, so it must not be used here.
// The mock's cswShapeOk enforces this exact Size/AddrInc shape and rejects
// every other encoding (including 0x95, 0x02000095 and 0x13).
constexpr uint32_t kApCsw32Auto = kApCswAhbDefault | 0x12u;

// Number of DP-AP chunks in one memory region (0x400 = 1 KiB boundary).
constexpr uint32_t kMemApBoundaryBytes = 0x400u;

// Bounded WAIT/FAULT retry budget per chunk. Counters are surfaced in the
// RPC diagnostics; exceeding the budget fails with the last ACK code.
constexpr uint32_t kMaxTransferRetries = 8;

// Diagnostics counters returned to the TypeScript layer.
struct DapTransferDiagnostics {
  uint32_t waitRetries = 0;    // WAIT retries spent on the operation
  uint32_t faultClears = 0;    // DP ABORT clears issued for FAULT recovery
  uint32_t chunks = 0;         // logical DP-AP chunks processed (retries excluded)
  uint32_t packets = 0;        // DAP_Transfer/DAP_TransferBlock commands sent
  uint32_t blockReads = 0;     // DAP_TransferBlock read commands actually sent
  uint32_t blockWrites = 0;    // DAP_TransferBlock write commands actually sent
};

// Cortex-M DP/AP adapter over CmsisDapProtocol. Implements the minimal
// SW-DP (IDCODE/CTRL-STAT/SELECT/ABORT) and MEM-AP (CSW/TAR/DRW) surface plus
// 32-bit Cortex-M memory reads with:
//  - TAR auto-increment chunking that never crosses a 1 KiB boundary
//  - DAP_TransferBlock batching bounded by the effective packet size
//  - WAIT: bounded retry of the affected chunk
//  - FAULT: DP ABORT (clear sticky) first, then bounded retry
//  - NO_ACK / malformed responses / device removal: immediate failure
//  - writes whose completion state is unknown are never retried
// All methods require an already connected SWD port.
class CmsisDapTarget {
 public:
  CmsisDapTarget(CmsisDapProtocol* protocol, uint16_t effectivePacketSize = 0)
      : protocol_(protocol),
        packetSize_(effectivePacketSize != 0
                        ? effectivePacketSize
                        : static_cast<uint16_t>(protocol->payloadCapacity())) {}

  // DP register access (addresses from the kDpReg* constants).
  Result readDp(uint8_t reg, uint32_t& value, DapTransferDiagnostics& diag,
                std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));
  Result writeDp(uint8_t reg, uint32_t value, DapTransferDiagnostics& diag,
                 std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // MEM-AP bank-0 register access (addresses from the kApReg* constants).
  // Reads flush through DP RDBUFF so the returned value is the one captured
  // by this access, not the previous one.
  Result readAp(uint8_t addr, uint32_t& value, DapTransferDiagnostics& diag,
                std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));
  Result writeAp(uint8_t addr, uint32_t value, DapTransferDiagnostics& diag,
                 std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Reads `wordCount` 32-bit words starting at the 4-byte aligned `address`.
  // `words` receives exactly wordCount entries on success.
  Result readMemoryBlock(uint32_t address, uint32_t wordCount, std::vector<uint32_t>& words,
                         DapTransferDiagnostics& diag,
                         std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Byte-oriented memory read of any size at any address. Unaligned ranges
  // are covered with aligned word reads and sliced on the host side.
  Result readMemory(uint32_t address, uint32_t size, std::vector<uint8_t>& bytes,
                    DapTransferDiagnostics& diag);

  // Writes a byte-oriented range. Partial words are read-modify-written while
  // the target is halted, then all writes use the bounded block-write path.
  Result writeMemory(uint32_t address, const std::vector<uint8_t>& bytes,
                     DapTransferDiagnostics& diag,
                     std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Writes `words` at a 4-byte aligned address. WAIT/FAULT writes are not
  // accepted by the target, so retrying them after clearing is safe;
  // malformed/unknown responses fail without a resend.
  Result writeMemoryBlock(uint32_t address, const std::vector<uint32_t>& words,
                          DapTransferDiagnostics& diag,
                          std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Clears the SW-DP sticky error flags via the DP ABORT register.
  Result clearStickyErrors(DapTransferDiagnostics& diag,
                           std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Requests and polls the ADIv5 debug/system power domains before MEM-AP or
  // CoreDebug access. The target must acknowledge both domains within the
  // bounded timeout; no AP access is attempted before this succeeds.
  Result initializeDebugPower(DapTransferDiagnostics& diag,
                              std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  uint16_t packetSize() const { return packetSize_; }

 private:
  friend class CortexMDebug;

  // Reads one AP register through [AP read][DP RDBUFF]. Returns the RDBUFF
  // value on success.
  Result readApCore(uint8_t addr, uint32_t& value, DapTransferDiagnostics& diag,
                    std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Batches DP SELECT, AP CSW and AP TAR into one CMSIS-DAP request. The
  // caller may then issue contiguous DRW block transfers until TAR reaches a
  // 1 KiB auto-increment boundary.
  Result setupMemoryAccess(uint32_t address, DapTransferDiagnostics& diag,
                           std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Batches SELECT/CSW/TAR with the pipelined AP DRW + DP RDBUFF read used to
  // obtain the first word of a memory chunk.
  Result readMemoryFirstWord(uint32_t address, uint32_t& value,
                             DapTransferDiagnostics& diag,
                             std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  // Internal-only single AP-DRW write for the Cortex-M CoreDebug register
  // allow-list. It is deliberately private and has no JSON-RPC counterpart.
  Result writeMemoryWordSingle(uint32_t address, uint32_t value,
                               DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout = std::chrono::milliseconds(2000));

  CmsisDapProtocol* protocol_;
  uint16_t packetSize_;
};

}  // namespace cmsis_dap_helper
