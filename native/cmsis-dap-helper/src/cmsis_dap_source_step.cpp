#include "cmsis_dap_source_step.h"

#include <algorithm>
#include <thread>

namespace cmsis_dap_helper {
namespace {

Result stepError(const char* code, const std::string& message) {
  return Result::error(code, message);
}

bool inRange(uint32_t pc, uint32_t start, uint32_t end) {
  return start != 0 && end > start && pc >= start && pc < end;
}

}  // namespace

Result CmsisDapSourceStepper::readPc(uint32_t& pc, DapTransferDiagnostics& diag,
                                    std::chrono::milliseconds timeout) {
  return debug_->readRegister(15, pc, diag, timeout);
}

Result CmsisDapSourceStepper::decode(uint32_t pc, Instruction& instruction,
                                    DapTransferDiagnostics& diag) {
  std::vector<uint8_t> bytes;
  const Result result = target_->readMemory(pc, 4, bytes, diag);
  if (!result.ok) return result;
  if (bytes.size() < 4) return stepError("StepReadInstructionFailed", "instruction read returned fewer than four bytes");
  const uint16_t hw1 = static_cast<uint16_t>(bytes[0]) |
                       (static_cast<uint16_t>(bytes[1]) << 8);
  const uint16_t hw2 = static_cast<uint16_t>(bytes[2]) |
                       (static_cast<uint16_t>(bytes[3]) << 8);
  const bool is32Bit = (hw1 & 0xF800u) == 0xE800u
                    || (hw1 & 0xF800u) == 0xF000u
                    || (hw1 & 0xF800u) == 0xF800u;
  instruction.width = is32Bit ? 4u : 2u;
  const bool blImmediate = (hw1 & 0xF800u) == 0xF000u
                        && (hw2 & 0xD000u) == 0xD000u;
  const bool blxImmediate = (hw1 & 0xF800u) == 0xF000u
                         && (hw2 & 0xD001u) == 0xC000u;
  instruction.call = (hw1 & 0xFF87u) == 0x4780u || blImmediate || blxImmediate;
  instruction.branch = (!is32Bit && ((hw1 & 0xF000u) == 0xD000u
                                  || (hw1 & 0xF800u) == 0xE000u
                                  || (hw1 & 0xF500u) == 0xB100u))
                    || (is32Bit && (hw1 & 0xF800u) == 0xF000u
                                  && (hw2 & 0xC000u) == 0x8000u);
  instruction.classification = instruction.call ? "call"
      : instruction.branch ? "branch" : "nonControl";
  return Result::success();
}

Result CmsisDapSourceStepper::stepPreservingUsers(
    uint32_t pc, CortexMDebugStepResult& step, std::vector<uint32_t>& restoredSlots,
    DapTransferDiagnostics& diag, std::chrono::milliseconds timeout) {
  std::vector<FpbBreakpointResult> disabled;
  Result result = fpb_.disableUsersAt(pc, disabled, diag, timeout);
  if (!result.ok) return result;
  const Result stepResult =
      debug_->stepInstructionFromHaltedPc(pc, step, diag, timeout);
  const Result restoreResult = fpb_.restoreUsers(disabled, diag, timeout);
  for (const auto& breakpoint : disabled) restoredSlots.push_back(breakpoint.slot);
  if (!restoreResult.ok) return stepError("StepCleanupFailed", restoreResult.message);
  return stepResult;
}

Result CmsisDapSourceStepper::waitForHalt(CortexMDebugState& state,
                                         DapTransferDiagnostics& diag,
                                         std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  for (;;) {
    Result result = debug_->getState(state, diag, timeout);
    if (!result.ok) return result;
    if (state.halted) return Result::success();
    if (std::chrono::steady_clock::now() >= deadline) {
      return stepError("StepTimeout", "target did not halt at the temporary breakpoint before timeout");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

Result CmsisDapSourceStepper::runTo(uint32_t currentPc, uint32_t address,
                                   SourceStepResult& output,
                                   DapTransferDiagnostics& diag,
                                   std::chrono::milliseconds timeout) {
  std::vector<FpbBreakpointResult> disabled;
  FpbBreakpointResult temporary;
  Result result = fpb_.disableUsersAt(currentPc, disabled, diag, timeout);
  if (!result.ok) return result;
  result = fpb_.installTemporary(address, temporary, diag, timeout);
  if (!result.ok) {
    const Result restore = fpb_.restoreUsers(disabled, diag, timeout);
    if (!restore.ok) return stepError("StepCleanupFailed", restore.message);
    return result;
  }
  output.temporaryBreakpointCount = temporary.sharedUserSlot ? 0u : 1u;
  output.temporarySlot = temporary.slot;
  output.returnAddress = temporary.address;

  Result operation = debug_->resume(diag, timeout);
  CortexMDebugState stopped;
  if (operation.ok) operation = waitForHalt(stopped, diag, timeout);
  if (!operation.ok) {
    CortexMDebugState recovery;
    (void)debug_->halt(recovery, diag, timeout);
  }

  const Result clear = fpb_.clearTemporary(temporary, diag, timeout);
  const Result restore = fpb_.restoreUsers(disabled, diag, timeout);
  for (const auto& breakpoint : disabled) output.restoredSlots.push_back(breakpoint.slot);
  output.cleanupOk = clear.ok && restore.ok;
  if (!output.cleanupOk) return stepError("StepCleanupFailed", clear.ok ? restore.message : clear.message);
  if (!operation.ok) return operation;
  output.pcAfter = stopped.pc;
  output.stopReason = stopped.pc == temporary.address ? "TemporaryBreakpoint" : "Breakpoint";
  return Result::success();
}

Result CmsisDapSourceStepper::stepInstruction(SourceStepResult& output,
                                              DapTransferDiagnostics& diag,
                                              std::chrono::milliseconds timeout) {
  Result result = readPc(output.pcBefore, diag, timeout);
  if (!result.ok) return result;
  CortexMDebugStepResult step;
  result = stepPreservingUsers(output.pcBefore, step, output.restoredSlots, diag, timeout);
  output.pcAfter = step.pcAfter;
  output.instructionRetired = step.instructionRetired;
  output.interruptMaskApplied = step.interruptMaskApplied;
  output.interruptMaskCleared = step.interruptMaskCleared;
  output.stepDhcsr = step.dhcsr;
  output.stepDhcsrPolls = step.dhcsrPolls;
  output.instructions = 1;
  output.classification = "instruction";
  output.cleanupOk = step.interruptMaskCleared && result.errorCode != "StepCleanupFailed";
  return result;
}

Result CmsisDapSourceStepper::stepInto(uint32_t lineStart, uint32_t lineEnd,
                                      uint32_t maxInstructions, SourceStepResult& output,
                                      DapTransferDiagnostics& diag,
                                      std::chrono::milliseconds timeout) {
  Result result = readPc(output.pcBefore, diag, timeout);
  if (!result.ok) return result;
  output.pcAfter = output.pcBefore;
  maxInstructions = std::max(1u, std::min(maxInstructions, 256u));
  for (uint32_t index = 0; index < maxInstructions; ++index) {
    Instruction instruction;
    result = decode(output.pcAfter, instruction, diag);
    if (!result.ok) return result;
    output.trace.push_back({output.pcAfter, instruction.classification, instruction.call});
    CortexMDebugStepResult step;
    result = stepPreservingUsers(output.pcAfter, step, output.restoredSlots, diag, timeout);
    output.instructionRetired = step.instructionRetired;
    output.interruptMaskApplied = output.interruptMaskApplied || step.interruptMaskApplied;
    output.interruptMaskCleared = output.interruptMaskCleared && step.interruptMaskCleared;
    output.stepDhcsr = step.dhcsr;
    output.stepDhcsrPolls += step.dhcsrPolls;
    if (!result.ok) {
      output.cleanupOk = output.interruptMaskCleared && result.errorCode != "StepCleanupFailed";
      return result;
    }
    ++output.instructions;
    output.pcAfter = step.pcAfter;
    if (instruction.call) {
      output.classification = "call";
      output.enteredCall = true;
      return Result::success();
    }
    if (!inRange(output.pcAfter, lineStart, lineEnd)) {
      output.classification = instruction.branch ? "branch" : "sourceBoundary";
      return Result::success();
    }
  }
  output.classification = "instructionLimit";
  return stepError("SourceLineStepLimitExceeded", "source step into remained in the line range after the instruction limit");
}

Result CmsisDapSourceStepper::stepOver(uint32_t lineStart, uint32_t lineEnd,
                                      uint32_t maxInstructions, SourceStepResult& output,
                                      DapTransferDiagnostics& diag,
                                      std::chrono::milliseconds timeout) {
  Result result = readPc(output.pcBefore, diag, timeout);
  if (!result.ok) return result;
  output.pcAfter = output.pcBefore;
  maxInstructions = std::max(1u, std::min(maxInstructions, 256u));
  for (uint32_t index = 0; index < maxInstructions; ++index) {
    Instruction instruction;
    result = decode(output.pcAfter, instruction, diag);
    if (!result.ok) return result;
    output.trace.push_back({output.pcAfter, instruction.classification, instruction.call});
    if (instruction.call) {
      output.classification = "callReturnBreakpoint";
      result = runTo(output.pcAfter, output.pcAfter + instruction.width, output, diag, timeout);
      if (!result.ok) return result;
    } else {
      CortexMDebugStepResult step;
      result = stepPreservingUsers(output.pcAfter, step, output.restoredSlots, diag, timeout);
      output.instructionRetired = step.instructionRetired;
      output.interruptMaskApplied = output.interruptMaskApplied || step.interruptMaskApplied;
      output.interruptMaskCleared = output.interruptMaskCleared && step.interruptMaskCleared;
      output.stepDhcsr = step.dhcsr;
      output.stepDhcsrPolls += step.dhcsrPolls;
      if (!result.ok) {
        output.cleanupOk = output.interruptMaskCleared && result.errorCode != "StepCleanupFailed";
        return result;
      }
      output.pcAfter = step.pcAfter;
      output.classification = instruction.branch ? "branchSingleStep" : "singleStep";
    }
    ++output.instructions;
    if (!inRange(output.pcAfter, lineStart, lineEnd)) return Result::success();
  }
  return stepError("SourceLineStepLimitExceeded", "source step over remained in the line range after the instruction limit");
}

Result CmsisDapSourceStepper::stepOut(uint32_t functionStart, uint32_t functionEnd,
                                     SourceStepResult& output,
                                     DapTransferDiagnostics& diag,
                                     std::chrono::milliseconds timeout) {
  std::vector<uint32_t> registers;
  Result result = debug_->readRegisters({15u, 14u, 13u}, registers, diag, timeout);
  if (!result.ok) return result;
  output.pcBefore = registers[0];
  if (!inRange(output.pcBefore, functionStart, functionEnd)) {
    return stepError("StepOutPcOutsideFunction", "current PC is outside the supplied function range");
  }
  const uint32_t lr = registers[1];
  const uint32_t sp = registers[2];
  output.lr = lr;
  output.sp = sp;

  uint32_t returnAddress = 0;
  if ((lr & 0xFFFFFF00u) == 0xFFFFFF00u) {
    const uint32_t stackRegister = (lr & 4u) != 0 ? 18u : 17u;
    uint32_t frameSp = 0;
    result = debug_->readRegister(stackRegister, frameSp, diag, timeout);
    if (!result.ok) return result;
    const uint32_t pcOffset = (lr & 0x10u) != 0 ? 24u : 96u;
    std::vector<uint32_t> stackedPc;
    result = target_->readMemoryBlock(frameSp + pcOffset, 1, stackedPc, diag, timeout);
    if (!result.ok || stackedPc.size() != 1) {
      return stepError("StepOutExceptionFrameInvalid", "failed to read the exception frame return PC");
    }
    returnAddress = stackedPc[0] & ~1u;
    output.classification = "exceptionReturnBreakpoint";
  } else {
    if ((lr & 1u) == 0) return stepError("StepOutInvalidLr", "LR is not a Thumb return address");
    returnAddress = lr & ~1u;
    output.classification = "returnBreakpoint";
  }
  if (inRange(returnAddress, functionStart, functionEnd)) {
    return stepError("StepOutReturnInsideFunction", "resolved return address is inside the current function");
  }
  std::vector<uint8_t> instruction;
  result = target_->readMemory(returnAddress, 2, instruction, diag);
  if (!result.ok || instruction.size() != 2) {
    return stepError("StepOutReturnUnreadable", "return address is not readable");
  }
  output.returnAddress = returnAddress;
  return runTo(output.pcBefore, returnAddress, output, diag, timeout);
}

}  // namespace cmsis_dap_helper
