#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <vector>

#include "cmsis_dap_target.h"

namespace cmsis_dap_helper {

constexpr uint32_t kFpbBase = 0xE0002000u;
constexpr uint32_t kFpbCtrl = kFpbBase;
constexpr uint32_t kFpbComp0 = kFpbBase + 8u;

struct FpbCapabilities {
  uint32_t fpCtrl = 0;
  uint32_t revision = 0;
  uint32_t codeComparators = 0;
  uint32_t literalComparators = 0;
  bool enabled = false;
};

struct FpbState {
  bool initialized = false;
  FpbCapabilities capabilities;
  std::vector<std::optional<uint32_t>> userSlots;

  void reset() {
    initialized = false;
    capabilities = FpbCapabilities{};
    userSlots.clear();
  }
};

struct FpbBreakpointResult {
  uint32_t slot = 0;
  uint32_t requestedAddress = 0;
  uint32_t address = 0;
  uint32_t comparatorValue = 0;
  uint32_t comparatorReadback = 0;
  bool duplicate = false;
  bool sharedUserSlot = false;
};

class FpbBreakpointManager {
 public:
  FpbBreakpointManager(CmsisDapTarget* target, FpbState* state)
      : target_(target), state_(state) {}

  Result initialize(FpbCapabilities& capabilities, DapTransferDiagnostics& diag,
                    std::chrono::milliseconds timeout);
  Result setUser(uint32_t requestedAddress, std::optional<uint32_t> preferredSlot,
                 FpbBreakpointResult& result, DapTransferDiagnostics& diag,
                 std::chrono::milliseconds timeout);
  Result clearUser(uint32_t slot, FpbBreakpointResult& result,
                   DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);
  Result clearAll(uint32_t& cleared, DapTransferDiagnostics& diag,
                  std::chrono::milliseconds timeout);

  Result installTemporary(uint32_t requestedAddress, FpbBreakpointResult& result,
                          DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);
  Result clearTemporary(const FpbBreakpointResult& breakpoint,
                        DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);
  Result disableUsersAt(uint32_t address, std::vector<FpbBreakpointResult>& disabled,
                        DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);
  Result restoreUsers(const std::vector<FpbBreakpointResult>& disabled,
                      DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);

  static Result encodeComparator(uint32_t revision, uint32_t requestedAddress,
                                 uint32_t& normalizedAddress, uint32_t& value);

 private:
  Result setEnabled(bool enabled, DapTransferDiagnostics& diag,
                    std::chrono::milliseconds timeout);
  Result writeComparator(uint32_t slot, uint32_t value, uint32_t& readback,
                         DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);
  Result readWord(uint32_t address, uint32_t& value, DapTransferDiagnostics& diag,
                  std::chrono::milliseconds timeout);
  Result writeWord(uint32_t address, uint32_t value, DapTransferDiagnostics& diag,
                   std::chrono::milliseconds timeout);

  CmsisDapTarget* target_;
  FpbState* state_;
};

}  // namespace cmsis_dap_helper
