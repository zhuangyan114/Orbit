#include "cmsis_dap_startup_stop.h"

#include <algorithm>
#include <thread>

namespace cmsis_dap_helper {
namespace {

Result startupError(const char* code, const std::string& message) {
  return Result::error(code, message);
}

}  // namespace

std::vector<uint32_t> CmsisDapStartupStop::userSlotsAt(uint32_t address) const {
  std::vector<uint32_t> slots;
  const uint32_t normalized = address & ~1u;
  if (!fpbState_->initialized) return slots;
  for (uint32_t slot = 0; slot < fpbState_->userSlots.size(); ++slot) {
    if (fpbState_->userSlots[slot] && *fpbState_->userSlots[slot] == normalized) {
      slots.push_back(slot);
    }
  }
  return slots;
}

Result CmsisDapStartupStop::captureLr(CortexMDebugState& state, uint32_t& lr,
                                      DapTransferDiagnostics& diagnostics,
                                      std::chrono::milliseconds timeout) {
  if (!state.halted || !state.pcValid) {
    return startupError("StartupStateInvalid",
                        "startup stop requires a halted target with a valid PC");
  }
  return debug_->readRegister(14, lr, diagnostics, timeout);
}

Result CmsisDapStartupStop::waitForHalt(
    CortexMDebugState& state, DapTransferDiagnostics& diagnostics,
    std::chrono::steady_clock::time_point deadline,
    std::chrono::milliseconds ioTimeout) {
  for (;;) {
    const Result result = debug_->getState(state, diagnostics, ioTimeout);
    if (!result.ok) return result;
    if (state.halted) return Result::success();
    if (std::chrono::steady_clock::now() >= deadline) {
      return startupError("StartupStopTimeout",
                          "target did not halt at the startup entry before timeout");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

Result CmsisDapStartupStop::stepPastUserBreakpoint(
    uint32_t pc, StartupStopResult& output,
    DapTransferDiagnostics& diagnostics,
    std::chrono::milliseconds timeout) {
  std::vector<FpbBreakpointResult> disabled;
  Result result = fpb_.disableUsersAt(pc, disabled, diagnostics, timeout);
  if (!result.ok) return result;

  CortexMDebugStepResult step;
  const Result stepResult =
      debug_->stepInstructionFromHaltedPc(pc, step, diagnostics, timeout);
  const Result restoreResult = fpb_.restoreUsers(disabled, diagnostics, timeout);
  for (const FpbBreakpointResult& breakpoint : disabled) {
    output.ignoredUserSlots.push_back(breakpoint.slot);
  }
  if (!restoreResult.ok) {
    return startupError("FpbCleanupFailed",
                        "failed to restore a user breakpoint while running to startup: " +
                            restoreResult.message);
  }
  return stepResult;
}

Result CmsisDapStartupStop::runToAddress(
    uint32_t requestedAddress, bool reset, StartupStopResult& output,
    DapTransferDiagnostics& diagnostics, std::chrono::milliseconds timeout) {
  output = StartupStopResult{};
  output.requestedAddress = requestedAddress;
  output.entryAddress = requestedAddress & ~1u;
  output.resetRequested = reset;

  CortexMDebugState state;
  Result operation = debug_->getState(state, diagnostics, timeout);
  if (!operation.ok) return operation;
  if (!state.halted) {
    operation = debug_->halt(state, diagnostics, timeout);
    if (!operation.ok) return operation;
  }
  if (!state.pcValid) {
    return startupError("StartupStateInvalid",
                        "target did not expose a valid halted PC before startup run");
  }
  if (!reset && (state.pc & ~1u) == output.entryAddress) {
    output.pc = state.pc & ~1u;
    output.dhcsr = state.dhcsr;
    operation = captureLr(state, output.lr, diagnostics, timeout);
    return operation;
  }

  FpbBreakpointResult temporary;
  operation = fpb_.installTemporary(requestedAddress, temporary,
                                    diagnostics, timeout);
  if (!operation.ok) return operation;
  output.entryAddress = temporary.address;
  output.sharedUserSlot = temporary.sharedUserSlot;
  output.temporarySlot = temporary.slot;
  output.temporaryBreakpointCount = temporary.sharedUserSlot ? 0u : 1u;

  if (reset) {
    operation = debug_->reset(state, diagnostics, timeout);
    if (operation.ok && !state.halted) {
      operation = debug_->halt(state, diagnostics, timeout);
    }
    if (operation.ok && !state.pcValid) {
      operation = startupError(
          "StartupStateInvalid",
          "target did not expose a valid halted PC after startup reset");
    }
    if (operation.ok) {
      output.resetDhcsr = state.dhcsr;
      output.resetPc = state.pc;
      output.resetPcValid = true;
      operation = captureLr(state, output.resetLr, diagnostics, timeout);
    }
  }

  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (operation.ok) {
    const uint32_t pc = state.pc & ~1u;
    if (pc == output.entryAddress) break;

    const std::vector<uint32_t> currentUserSlots = userSlotsAt(pc);
    if (!currentUserSlots.empty()) {
      operation = stepPastUserBreakpoint(pc, output, diagnostics, timeout);
      if (!operation.ok) break;
      operation = debug_->getState(state, diagnostics, timeout);
      if (!operation.ok) break;
      continue;
    }

    operation = debug_->resume(diagnostics, timeout);
    if (!operation.ok) break;
    operation = waitForHalt(state, diagnostics, deadline, timeout);
    if (!operation.ok) break;
    if ((state.pc & ~1u) != output.entryAddress && userSlotsAt(state.pc).empty()) {
      operation = startupError(
          "StartupUnexpectedStop",
          "target halted before the requested startup entry at an unowned PC");
      break;
    }
  }

  Result recovery = Result::success();
  if (!operation.ok) {
    CortexMDebugState recoveryState;
    recovery = debug_->halt(recoveryState, diagnostics, timeout);
    if (recovery.ok) state = recoveryState;
  }

  const Result cleanup = fpb_.clearTemporary(temporary, diagnostics, timeout);
  output.cleanupOk = cleanup.ok;
  if (!cleanup.ok) {
    return startupError("FpbCleanupFailed",
                        "failed to release the startup breakpoint comparator: " +
                            cleanup.message);
  }
  if (!recovery.ok) {
    return startupError("StartupRecoveryFailed",
                        "failed to halt the target after startup stop failure: " +
                            recovery.message);
  }
  if (!operation.ok) return operation;

  operation = debug_->getState(state, diagnostics, timeout);
  if (!operation.ok) return operation;
  if (!state.halted || !state.pcValid ||
      (state.pc & ~1u) != output.entryAddress) {
    return startupError("StartupEntryNotReached",
                        "startup stop completed without a trusted entry PC");
  }
  output.pc = state.pc & ~1u;
  output.dhcsr = state.dhcsr;
  return captureLr(state, output.lr, diagnostics, timeout);
}

}  // namespace cmsis_dap_helper
