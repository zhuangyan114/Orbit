#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <vector>

#include "cortex_m_debug.h"
#include "fpb_breakpoint.h"

namespace cmsis_dap_helper {

struct StartupStopResult {
  uint32_t requestedAddress = 0;
  uint32_t entryAddress = 0;
  uint32_t resetDhcsr = 0;
  uint32_t resetPc = 0;
  uint32_t resetLr = 0;
  uint32_t pc = 0;
  uint32_t lr = 0;
  uint32_t dhcsr = 0;
  bool resetRequested = false;
  bool resetPcValid = false;
  bool cleanupOk = true;
  bool sharedUserSlot = false;
  uint32_t temporaryBreakpointCount = 0;
  std::optional<uint32_t> temporarySlot;
  std::vector<uint32_t> ignoredUserSlots;
};

class CmsisDapStartupStop {
 public:
  CmsisDapStartupStop(CmsisDapTarget* target, CortexMDebug* debug,
                      FpbState* fpbState)
      : debug_(debug), fpbState_(fpbState), fpb_(target, fpbState) {}

  Result runToAddress(uint32_t requestedAddress, bool reset,
                      StartupStopResult& output,
                      DapTransferDiagnostics& diagnostics,
                      std::chrono::milliseconds timeout);

 private:
  Result waitForHalt(CortexMDebugState& state,
                     DapTransferDiagnostics& diagnostics,
                     std::chrono::steady_clock::time_point deadline,
                     std::chrono::milliseconds ioTimeout);
  std::vector<uint32_t> userSlotsAt(uint32_t address) const;
  Result stepPastUserBreakpoint(uint32_t pc,
                                StartupStopResult& output,
                                DapTransferDiagnostics& diagnostics,
                                std::chrono::milliseconds timeout);
  Result captureLr(CortexMDebugState& state, uint32_t& lr,
                   DapTransferDiagnostics& diagnostics,
                   std::chrono::milliseconds timeout);

  CortexMDebug* debug_;
  FpbState* fpbState_;
  FpbBreakpointManager fpb_;
};

}  // namespace cmsis_dap_helper
