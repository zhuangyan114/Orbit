#include "fpb_breakpoint.h"

#include <algorithm>
#include <string>

namespace cmsis_dap_helper {
namespace {

constexpr uint32_t kFpbCtrlEnable = 1u;
constexpr uint32_t kFpbCtrlKey = 2u;

Result fpbError(const char* code, const std::string& message) {
  return Result::error(code, message);
}

}  // namespace

Result FpbBreakpointManager::readWord(uint32_t address, uint32_t& value,
                                      DapTransferDiagnostics& diag,
                                      std::chrono::milliseconds timeout) {
  std::vector<uint32_t> words;
  const Result result = target_->readMemoryBlock(address, 1, words, diag, timeout);
  if (!result.ok) return result;
  if (words.size() != 1) return fpbError("FpbReadbackFailed", "FPB register read returned no word");
  value = words[0];
  return Result::success();
}

Result FpbBreakpointManager::writeWord(uint32_t address, uint32_t value,
                                       DapTransferDiagnostics& diag,
                                       std::chrono::milliseconds timeout) {
  return target_->writeMemoryBlock(address, {value}, diag, timeout);
}

Result FpbBreakpointManager::initialize(FpbCapabilities& capabilities,
                                        DapTransferDiagnostics& diag,
                                        std::chrono::milliseconds timeout) {
  if (state_->initialized) {
    capabilities = state_->capabilities;
    return Result::success();
  }

  uint32_t control = 0;
  Result result = readWord(kFpbCtrl, control, diag, timeout);
  if (!result.ok) return result;
  FpbCapabilities detected;
  detected.fpCtrl = control;
  detected.revision = 1u + ((control >> 28) & 0x0Fu);
  detected.codeComparators = ((control >> 8) & 0x70u) | ((control >> 4) & 0x0Fu);
  detected.literalComparators = (control >> 8) & 0x0Fu;
  detected.enabled = (control & kFpbCtrlEnable) != 0;
  if (detected.revision != 1 && detected.revision != 2) {
    return fpbError("UnsupportedFpbRevision",
                    "FPB revision " + std::to_string(detected.revision) + " is not supported");
  }
  if (detected.codeComparators == 0) {
    return fpbError("BreakpointResourceExhausted", "target reports no FPB code comparators");
  }

  state_->capabilities = detected;
  state_->userSlots.assign(detected.codeComparators, std::nullopt);
  state_->initialized = true;

  result = setEnabled(false, diag, timeout);
  if (!result.ok) {
    state_->reset();
    return result;
  }
  for (uint32_t slot = 0; slot < detected.codeComparators; ++slot) {
    uint32_t readback = 0;
    result = writeComparator(slot, 0, readback, diag, timeout);
    if (!result.ok) {
      state_->reset();
      return result;
    }
  }
  state_->capabilities.fpCtrl = control & ~kFpbCtrlEnable;
  state_->capabilities.enabled = false;
  capabilities = state_->capabilities;
  return Result::success();
}

Result FpbBreakpointManager::encodeComparator(uint32_t revision, uint32_t requestedAddress,
                                              uint32_t& normalizedAddress, uint32_t& value) {
  normalizedAddress = requestedAddress & ~1u;
  if (revision == 1) {
    if (normalizedAddress >= 0x20000000u) {
      return fpbError("InvalidBreakpointAddress",
                      "FPBv1 code comparator address must be below 0x20000000");
    }
    const uint32_t replace = (normalizedAddress & 2u) == 0 ? 1u : 2u;
    value = (normalizedAddress & 0x1FFFFFFCu) | (replace << 30) | 1u;
    return Result::success();
  }
  if (revision == 2) {
    value = (normalizedAddress & 0xFFFFFFFEu) | 1u;
    return Result::success();
  }
  return fpbError("UnsupportedFpbRevision", "cannot encode comparator for unsupported FPB revision");
}

Result FpbBreakpointManager::setEnabled(bool enabled, DapTransferDiagnostics& diag,
                                        std::chrono::milliseconds timeout) {
  Result result = writeWord(kFpbCtrl, kFpbCtrlKey | (enabled ? kFpbCtrlEnable : 0u), diag, timeout);
  if (!result.ok) return result;
  uint32_t readback = 0;
  result = readWord(kFpbCtrl, readback, diag, timeout);
  if (!result.ok) return result;
  if (((readback & kFpbCtrlEnable) != 0) != enabled) {
    return fpbError("FpbReadbackFailed", "FP_CTRL enable readback did not match the requested state");
  }
  state_->capabilities.fpCtrl = readback;
  state_->capabilities.enabled = enabled;
  return Result::success();
}

Result FpbBreakpointManager::writeComparator(uint32_t slot, uint32_t value, uint32_t& readback,
                                             DapTransferDiagnostics& diag,
                                             std::chrono::milliseconds timeout) {
  if (!state_->initialized || slot >= state_->capabilities.codeComparators) {
    return fpbError("InvalidBreakpointSlot", "FPB comparator slot is outside the reported range");
  }
  const uint32_t address = kFpbComp0 + slot * 4u;
  Result result = writeWord(address, value, diag, timeout);
  if (!result.ok) return result;
  result = readWord(address, readback, diag, timeout);
  if (!result.ok) return result;
  if (readback != value) {
    return fpbError("FpbReadbackFailed", "FP_COMP readback differs from the value written");
  }
  return Result::success();
}

Result FpbBreakpointManager::setUser(uint32_t requestedAddress,
                                     std::optional<uint32_t> preferredSlot,
                                     FpbBreakpointResult& output,
                                     DapTransferDiagnostics& diag,
                                     std::chrono::milliseconds timeout) {
  FpbCapabilities capabilities;
  Result result = initialize(capabilities, diag, timeout);
  if (!result.ok) return result;
  uint32_t normalized = 0;
  uint32_t comparator = 0;
  result = encodeComparator(capabilities.revision, requestedAddress, normalized, comparator);
  if (!result.ok) return result;

  for (uint32_t slot = 0; slot < state_->userSlots.size(); ++slot) {
    if (state_->userSlots[slot] && *state_->userSlots[slot] == normalized) {
      output = {slot, requestedAddress, normalized, comparator, comparator, true, true};
      return Result::success();
    }
  }

  uint32_t slot = static_cast<uint32_t>(state_->userSlots.size());
  if (preferredSlot) {
    if (*preferredSlot >= state_->userSlots.size()) {
      return fpbError("InvalidBreakpointSlot", "preferred FPB slot is outside the reported range");
    }
    if (state_->userSlots[*preferredSlot]) {
      return fpbError("BreakpointSlotUnavailable", "preferred FPB slot is already owned by a user breakpoint");
    }
    slot = *preferredSlot;
  } else {
    for (uint32_t candidate = 0; candidate < state_->userSlots.size(); ++candidate) {
      if (!state_->userSlots[candidate]) {
        slot = candidate;
        break;
      }
    }
  }
  if (slot >= state_->userSlots.size()) {
    return fpbError("BreakpointResourceExhausted", "all target-reported FPB code comparators are occupied");
  }
  if (!state_->capabilities.enabled) {
    result = setEnabled(true, diag, timeout);
    if (!result.ok) return result;
  }
  uint32_t readback = 0;
  result = writeComparator(slot, comparator, readback, diag, timeout);
  if (!result.ok) return result;
  state_->userSlots[slot] = normalized;
  output = {slot, requestedAddress, normalized, comparator, readback, false, false};
  return Result::success();
}

Result FpbBreakpointManager::clearUser(uint32_t slot, FpbBreakpointResult& output,
                                       DapTransferDiagnostics& diag,
                                       std::chrono::milliseconds timeout) {
  FpbCapabilities capabilities;
  Result result = initialize(capabilities, diag, timeout);
  if (!result.ok) return result;
  if (slot >= state_->userSlots.size()) {
    return fpbError("InvalidBreakpointSlot", "FPB comparator slot is outside the reported range");
  }
  const uint32_t address = state_->userSlots[slot].value_or(0);
  uint32_t readback = 0;
  result = writeComparator(slot, 0, readback, diag, timeout);
  if (!result.ok) return result;
  state_->userSlots[slot].reset();
  output = {slot, address, address, 0, readback, false, false};
  const bool any = std::any_of(state_->userSlots.begin(), state_->userSlots.end(),
                               [](const auto& item) { return item.has_value(); });
  if (!any) return setEnabled(false, diag, timeout);
  return Result::success();
}

Result FpbBreakpointManager::clearAll(uint32_t& cleared, DapTransferDiagnostics& diag,
                                      std::chrono::milliseconds timeout) {
  cleared = 0;
  if (!state_->initialized) return Result::success();
  for (uint32_t slot = 0; slot < state_->userSlots.size(); ++slot) {
    if (state_->userSlots[slot]) ++cleared;
    uint32_t readback = 0;
    const Result result = writeComparator(slot, 0, readback, diag, timeout);
    if (!result.ok) return result;
    state_->userSlots[slot].reset();
  }
  return setEnabled(false, diag, timeout);
}

Result FpbBreakpointManager::installTemporary(uint32_t requestedAddress,
                                              FpbBreakpointResult& output,
                                              DapTransferDiagnostics& diag,
                                              std::chrono::milliseconds timeout) {
  FpbCapabilities capabilities;
  Result result = initialize(capabilities, diag, timeout);
  if (!result.ok) return result;
  uint32_t normalized = 0;
  uint32_t comparator = 0;
  result = encodeComparator(capabilities.revision, requestedAddress, normalized, comparator);
  if (!result.ok) return result;
  for (uint32_t slot = 0; slot < state_->userSlots.size(); ++slot) {
    if (state_->userSlots[slot] && *state_->userSlots[slot] == normalized) {
      output = {slot, requestedAddress, normalized, comparator, comparator, false, true};
      return Result::success();
    }
  }
  uint32_t slot = static_cast<uint32_t>(state_->userSlots.size());
  for (uint32_t candidate = 0; candidate < state_->userSlots.size(); ++candidate) {
    if (!state_->userSlots[candidate]) {
      slot = candidate;
      break;
    }
  }
  if (slot >= state_->userSlots.size()) {
    return fpbError("BreakpointResourceExhausted", "no FPB comparator is available for a temporary step breakpoint");
  }
  if (!state_->capabilities.enabled) {
    result = setEnabled(true, diag, timeout);
    if (!result.ok) return result;
  }
  uint32_t readback = 0;
  result = writeComparator(slot, comparator, readback, diag, timeout);
  if (!result.ok) return result;
  output = {slot, requestedAddress, normalized, comparator, readback, false, false};
  return Result::success();
}

Result FpbBreakpointManager::clearTemporary(const FpbBreakpointResult& breakpoint,
                                            DapTransferDiagnostics& diag,
                                            std::chrono::milliseconds timeout) {
  if (breakpoint.sharedUserSlot) return Result::success();
  uint32_t readback = 0;
  Result result = writeComparator(breakpoint.slot, 0, readback, diag, timeout);
  if (!result.ok) return result;
  const bool anyUsers = std::any_of(state_->userSlots.begin(), state_->userSlots.end(),
                                    [](const auto& item) { return item.has_value(); });
  return anyUsers ? Result::success() : setEnabled(false, diag, timeout);
}

Result FpbBreakpointManager::disableUsersAt(uint32_t address,
                                            std::vector<FpbBreakpointResult>& disabled,
                                            DapTransferDiagnostics& diag,
                                            std::chrono::milliseconds timeout) {
  const uint32_t normalized = address & ~1u;
  for (uint32_t slot = 0; slot < state_->userSlots.size(); ++slot) {
    if (!state_->userSlots[slot] || *state_->userSlots[slot] != normalized) continue;
    uint32_t comparator = 0;
    uint32_t encodedAddress = 0;
    Result result = encodeComparator(state_->capabilities.revision, normalized,
                                     encodedAddress, comparator);
    if (!result.ok) return result;
    uint32_t readback = 0;
    result = writeComparator(slot, 0, readback, diag, timeout);
    if (!result.ok) {
      const Result rollback = restoreUsers(disabled, diag, timeout);
      if (!rollback.ok) {
        return fpbError("FpbCleanupFailed",
                        "failed to restore user comparators after partial disable: " +
                            rollback.message);
      }
      return result;
    }
    disabled.push_back({slot, normalized, normalized, comparator, readback, false, true});
  }
  return Result::success();
}

Result FpbBreakpointManager::restoreUsers(const std::vector<FpbBreakpointResult>& disabled,
                                          DapTransferDiagnostics& diag,
                                          std::chrono::milliseconds timeout) {
  for (const FpbBreakpointResult& breakpoint : disabled) {
    uint32_t readback = 0;
    const Result result = writeComparator(breakpoint.slot, breakpoint.comparatorValue,
                                          readback, diag, timeout);
    if (!result.ok) return result;
  }
  return Result::success();
}

}  // namespace cmsis_dap_helper
