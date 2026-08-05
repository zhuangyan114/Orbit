#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "cmsis_dap_target.h"

namespace cmsis_dap_helper {

// ARMv7-M CoreDebug register addresses from the Cortex-M Debug Architecture.
constexpr uint32_t kCoreDebugDhcsr = 0xE000EDF0u;
constexpr uint32_t kCoreDebugDcrsr = 0xE000EDF4u;
constexpr uint32_t kCoreDebugDcrdr = 0xE000EDF8u;
constexpr uint32_t kCoreDebugAircr = 0xE000ED0Cu;
constexpr uint32_t kCortexFaultCfsr = 0xE000ED28u;
constexpr uint32_t kCortexFaultHfsr = 0xE000ED2Cu;
constexpr uint32_t kCortexFaultDfsr = 0xE000ED30u;
constexpr uint32_t kCortexFaultMmfar = 0xE000ED34u;
constexpr uint32_t kCortexFaultBfar = 0xE000ED38u;

// DHCSR status/control fields. A write to DHCSR must carry DBGKEY in bits
// 31:16; the low control bits are C_DEBUGEN, C_HALT and C_STEP.
constexpr uint32_t kCoreDebugSHalt = 1u << 17;
constexpr uint32_t kCoreDebugSRegReady = 1u << 16;
constexpr uint32_t kCoreDebugDbgKey = 0xA05Fu << 16;
constexpr uint32_t kCoreDebugCDebugEn = 1u << 0;
constexpr uint32_t kCoreDebugCHalt = 1u << 1;
constexpr uint32_t kCoreDebugCStep = 1u << 2;
constexpr uint32_t kCortexXpsrThumb = 1u << 24;
constexpr uint32_t kCoreDebugSLockup = 1u << 19;

// DCRSR REGSEL occupies bits 4:0 for the Cortex-M core register index.
constexpr uint32_t kCoreDebugRegSelMask = 0x1Fu;
// DCRSR REGWnR selects a transfer from DCRDR to the core register. A zero
// value selects the opposite direction (core register to DCRDR).
constexpr uint32_t kCoreDebugRegWrite = 1u << 16;

// AIRCR reset request fields. VECTKEY is required for writes to AIRCR.
constexpr uint32_t kCoreDebugVectKey = 0x5FAu << 16;
constexpr uint32_t kCoreDebugSysResetReq = 1u << 2;

struct CortexMDebugState {
  bool halted = false;
  uint32_t dhcsr = 0;
  uint32_t pc = 0;
  bool pcValid = false;
};

struct CortexMDebugStepResult {
  bool halted = false;
  uint32_t dhcsr = 0;
  uint32_t pcBefore = 0;
  uint32_t pcAfter = 0;
};

struct CortexRegisterSnapshot {
  bool dhcsrValid = false;
  uint32_t dhcsr = 0;
  bool registersValid = false;
  uint32_t pc = 0;
  uint32_t lr = 0;
  uint32_t sp = 0;
  uint32_t xpsr = 0;
  uint32_t r0 = 0;
  uint32_t r1 = 0;
  uint32_t r2 = 0;
  uint32_t r3 = 0;
  uint32_t r9 = 0;
  bool faultStatusValid = false;
  uint32_t cfsr = 0;
  uint32_t hfsr = 0;
  uint32_t dfsr = 0;
  uint32_t bfar = 0;
  uint32_t mmfar = 0;
};

struct CortexMDebugDiagnostics {
  std::string operation;
  uint32_t entry = 0;
  uint32_t bkptAddress = 0;
  uint32_t algorithmAddress = 0;
  uint32_t algorithmLength = 0;
  uint32_t staticBase = 0;
  uint32_t stackPointer = 0;
  uint32_t pageBufferAddress = 0;
  uint32_t targetAddress = 0;
  uint32_t size = 0;
  uint64_t elapsedMs = 0;
  std::string errorCode;
  CortexRegisterSnapshot before;
  CortexRegisterSnapshot after;
};

struct FlashAlgorithmRunRequest {
  std::string operation;
  const std::vector<uint8_t>* code = nullptr;
  uint32_t algorithmAddress = 0;
  uint32_t entry = 0;
  uint32_t bkptAddress = 0;
  uint32_t stackPointer = 0;
  uint32_t stackSize = 0;
  uint32_t pageBufferAddress = 0;
  uint32_t targetAddress = 0;
  uint32_t size = 0;
  const std::vector<uint8_t>* data = nullptr;
  uint32_t r0 = 0;
  uint32_t r1 = 0;
  uint32_t r2 = 0;
  uint32_t r3 = 0;
  uint32_t staticBase = 0;
  uint32_t timeoutMs = 0;
  // The helper may keep the validated code image in the target SRAM for the
  // duration of one owner session.
  bool loadAlgorithmCode = true;
  // Set only by the helper after it validates that the immediately preceding
  // successful ProgramPage left the exact requested bytes in this buffer.
  bool loadPageData = true;
};

struct FlashAlgorithmRunResult {
  uint32_t returnCode = 0;
  uint32_t pc = 0;
  uint32_t dhcsr = 0;
};

class CortexMDebug {
 public:
  explicit CortexMDebug(CmsisDapTarget* target) : target_(target) {}

  Result getState(CortexMDebugState& state, DapTransferDiagnostics& diag,
                  std::chrono::milliseconds timeout);
  Result halt(CortexMDebugState& state, DapTransferDiagnostics& diag,
              std::chrono::milliseconds timeout);
  Result run(CortexMDebugState& state, DapTransferDiagnostics& diag,
             std::chrono::milliseconds timeout);
  Result reset(CortexMDebugState& state, DapTransferDiagnostics& diag,
               std::chrono::milliseconds timeout);
  Result stepInstruction(CortexMDebugStepResult& step, DapTransferDiagnostics& diag,
                         std::chrono::milliseconds timeout);
  Result readRegister(uint32_t index, uint32_t& value, DapTransferDiagnostics& diag,
                      std::chrono::milliseconds timeout);
  Result executeFlashAlgorithm(const FlashAlgorithmRunRequest& request,
                               FlashAlgorithmRunResult& result,
                               DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout,
                               CortexMDebugDiagnostics* operationDiagnostics = nullptr);

 private:
  Result readWord(uint32_t address, uint32_t& value, DapTransferDiagnostics& diag,
                  std::chrono::milliseconds timeout);
  Result writeWord(uint32_t address, uint32_t value, DapTransferDiagnostics& diag,
                   std::chrono::milliseconds timeout);
  Result writeCoreRegister(uint32_t index, uint32_t value, DapTransferDiagnostics& diag,
                           std::chrono::milliseconds timeout);
  Result readDhcsr(uint32_t& value, DapTransferDiagnostics& diag,
                   std::chrono::milliseconds timeout);
  Result waitForHalt(bool halted, uint32_t& dhcsr, DapTransferDiagnostics& diag,
                     std::chrono::milliseconds timeout,
                     const char* operation = nullptr,
                     CortexMDebugDiagnostics* operationDiagnostics = nullptr);
  Result captureSnapshot(CortexRegisterSnapshot& snapshot,
                         DapTransferDiagnostics& diag,
                         std::chrono::milliseconds timeout);
  Result clearFaultStatus(DapTransferDiagnostics& diag,
                          std::chrono::milliseconds timeout);
  Result fillState(uint32_t dhcsr, CortexMDebugState& state, DapTransferDiagnostics& diag,
                   std::chrono::milliseconds timeout);

  CmsisDapTarget* target_;
};

}  // namespace cmsis_dap_helper
