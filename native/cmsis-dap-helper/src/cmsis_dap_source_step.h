#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "cortex_m_debug.h"
#include "fpb_breakpoint.h"

namespace cmsis_dap_helper {

struct SourceStepTraceEntry {
  uint32_t pc = 0;
  std::string classification;
  bool call = false;
};

struct SourceStepResult {
  uint32_t pcBefore = 0;
  uint32_t pcAfter = 0;
  uint32_t instructions = 0;
  std::string classification;
  std::string stopReason = "SingleStep";
  bool cleanupOk = true;
  bool enteredCall = false;
  bool instructionRetired = false;
  bool interruptMaskApplied = false;
  bool interruptMaskCleared = true;
  uint32_t stepDhcsr = 0;
  uint32_t stepDhcsrPolls = 0;
  uint32_t temporaryBreakpointCount = 0;
  std::optional<uint32_t> temporarySlot;
  std::optional<uint32_t> returnAddress;
  std::optional<uint32_t> lr;
  std::optional<uint32_t> sp;
  std::vector<uint32_t> restoredSlots;
  std::vector<SourceStepTraceEntry> trace;
};

class CmsisDapSourceStepper {
 public:
  CmsisDapSourceStepper(CmsisDapTarget* target, CortexMDebug* debug, FpbState* fpbState)
      : target_(target), debug_(debug), fpb_(target, fpbState) {}

  Result stepInto(uint32_t lineStart, uint32_t lineEnd, uint32_t maxInstructions,
                  SourceStepResult& output, DapTransferDiagnostics& diag,
                  std::chrono::milliseconds timeout);
  Result stepOver(uint32_t lineStart, uint32_t lineEnd, uint32_t maxInstructions,
                  SourceStepResult& output, DapTransferDiagnostics& diag,
                  std::chrono::milliseconds timeout);
  Result stepOut(uint32_t functionStart, uint32_t functionEnd,
                 SourceStepResult& output, DapTransferDiagnostics& diag,
                 std::chrono::milliseconds timeout);
  Result stepInstruction(SourceStepResult& output, DapTransferDiagnostics& diag,
                         std::chrono::milliseconds timeout);

 private:
  struct Instruction {
    uint32_t width = 2;
    bool call = false;
    bool branch = false;
    std::string classification = "nonControl";
  };

  Result readPc(uint32_t& pc, DapTransferDiagnostics& diag,
                std::chrono::milliseconds timeout);
  Result decode(uint32_t pc, Instruction& instruction, DapTransferDiagnostics& diag);
  Result stepPreservingUsers(uint32_t pc, CortexMDebugStepResult& step,
                             std::vector<uint32_t>& restoredSlots,
                             DapTransferDiagnostics& diag,
                             std::chrono::milliseconds timeout);
  Result runTo(uint32_t currentPc, uint32_t address, SourceStepResult& output,
               DapTransferDiagnostics& diag, std::chrono::milliseconds timeout);
  Result waitForHalt(CortexMDebugState& state, DapTransferDiagnostics& diag,
                     std::chrono::milliseconds timeout);

  CmsisDapTarget* target_;
  CortexMDebug* debug_;
  FpbBreakpointManager fpb_;
};

}  // namespace cmsis_dap_helper
