#include "cortex_m_debug.h"

#include <algorithm>
#include <sstream>
#include <thread>

namespace cmsis_dap_helper {
namespace {

std::chrono::milliseconds ioTimeout(std::chrono::milliseconds timeout) {
  return std::max(std::chrono::milliseconds(1),
                  std::min(timeout, std::chrono::milliseconds(2000)));
}

Result invalidRegister(uint32_t index) {
  return Result::error(ErrorCodes::kDapInvalidRequest,
                       "Cortex-M register index " + std::to_string(index) +
                           " is outside the supported range 0..16");
}

std::string hexValue(bool valid, uint32_t value) {
  if (!valid) return "unknown";
  std::ostringstream out;
  out << "0x" << std::hex << value;
  return out.str();
}

const char* effectiveOperation(const char* operation) {
  return operation && *operation ? operation : "control";
}

}  // namespace

Result CortexMDebug::readWord(uint32_t address, uint32_t& value,
                              DapTransferDiagnostics& diag,
                              std::chrono::milliseconds timeout) {
  std::vector<uint32_t> words;
  const Result result = target_->readMemoryBlock(address, 1, words, diag, ioTimeout(timeout));
  if (!result.ok) return result;
  if (words.size() != 1) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "CoreDebug read returned an unexpected word count at 0x" +
                             std::to_string(address));
  }
  value = words[0];
  return Result::success();
}

Result CortexMDebug::clearFaultStatus(DapTransferDiagnostics& diag,
                                       std::chrono::milliseconds timeout) {
  Result result = writeWord(kCortexFaultCfsr, 0xFFFFFFFFu, diag, timeout);
  if (!result.ok) return result;
  result = writeWord(kCortexFaultHfsr, 0xFFFFFFFFu, diag, timeout);
  if (!result.ok) return result;
  return writeWord(kCortexFaultDfsr, 0xFFFFFFFFu, diag, timeout);
}

Result CortexMDebug::writeWord(uint32_t address, uint32_t value,
                               DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout) {
  // This private path is deliberately limited to CoreDebug and fault-status
  // registers used by this class. No generic writeMemory RPC is built on top of it.
  if (address != kCoreDebugDhcsr && address != kCoreDebugDcrsr &&
      address != kCoreDebugDcrdr && address != kCoreDebugAircr) {
    if (address == kCortexFaultCfsr || address == kCortexFaultHfsr ||
        address == kCortexFaultDfsr) {
      return target_->writeMemoryWordSingle(address, value, diag, ioTimeout(timeout));
    }
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "address is not an allowed Cortex-M debug register");
  }
  return target_->writeMemoryWordSingle(address, value, diag, ioTimeout(timeout));
}

Result CortexMDebug::writeCoreRegister(uint32_t index, uint32_t value,
                                       DapTransferDiagnostics& diag,
                                       std::chrono::milliseconds timeout) {
  if (index > 16) return invalidRegister(index);
  // Cortex-M core-register writes use the DCRDR -> core direction selected by
  // DCRSR.REGWnR. DCRDR must be loaded first, then DCRSR starts the transfer.
  Result result = writeWord(kCoreDebugDcrdr, value, diag, timeout);
  if (!result.ok) return result;
  result = writeWord(kCoreDebugDcrsr, kCoreDebugRegWrite | (index & kCoreDebugRegSelMask),
                     diag, timeout);
  if (!result.ok) return result;

  uint32_t dhcsr = 0;
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  for (;;) {
    result = readDhcsr(dhcsr, diag, timeout);
    if (!result.ok) return result;
    if ((dhcsr & kCoreDebugSRegReady) != 0) return Result::success();
    if (std::chrono::steady_clock::now() >= deadline) {
      return Result::error(ErrorCodes::kDapControlTimeout,
                           "Cortex-M DCRSR write did not become ready before timeout");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

Result CortexMDebug::readDhcsr(uint32_t& value, DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout) {
  return readWord(kCoreDebugDhcsr, value, diag, timeout);
}

Result CortexMDebug::waitForHalt(bool halted, uint32_t& dhcsr,
                                 DapTransferDiagnostics& diag,
                                 std::chrono::milliseconds timeout,
                                 const char* operation,
                                 CortexMDebugDiagnostics* operationDiagnostics) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  for (;;) {
    const Result result = readDhcsr(dhcsr, diag, timeout);
    if (!result.ok) return result;
    if (((dhcsr & kCoreDebugSHalt) != 0) == halted) return Result::success();
    if ((dhcsr & kCoreDebugSLockup) != 0) break;
    if (std::chrono::steady_clock::now() >= deadline) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  if (operationDiagnostics) {
    (void)captureSnapshot(operationDiagnostics->after, diag, ioTimeout(timeout));
  }
  const CortexRegisterSnapshot* snapshot = operationDiagnostics
                                                ? &operationDiagnostics->after
                                                : nullptr;
  // DCRSR core-register reads are only valid while the Cortex-M is halted.
  // If a timed-out operation is still running, keep the last trusted core
  // values from the invocation snapshot and report the timeout DHCSR/fault
  // state separately instead of forcing a halt or fabricating an after-state.
  const CortexRegisterSnapshot* registerSnapshot =
      snapshot && snapshot->registersValid
          ? snapshot
          : (operationDiagnostics && operationDiagnostics->before.registersValid
                 ? &operationDiagnostics->before
                 : snapshot);
  const bool registerValuesValid = registerSnapshot && registerSnapshot->registersValid;
  const bool lockup = (snapshot && snapshot->dhcsrValid &&
                       (snapshot->dhcsr & kCoreDebugSLockup) != 0);
  const std::string detail = std::string(" operation=") + effectiveOperation(operation) +
                             " pc=" + hexValue(registerValuesValid,
                                               registerSnapshot ? registerSnapshot->pc : 0) +
                             " lr=" + hexValue(registerValuesValid,
                                               registerSnapshot ? registerSnapshot->lr : 0) +
                             " sp=" + hexValue(registerValuesValid,
                                               registerSnapshot ? registerSnapshot->sp : 0) +
                             " registerSource=" +
                                 (!operationDiagnostics
                                      ? "unavailable"
                                      : registerSnapshot == snapshot ? "after" : "before") +
                             " dhcsr=" + hexValue(snapshot && snapshot->dhcsrValid,
                                                  snapshot ? snapshot->dhcsr : dhcsr) +
                             " cfsr=" + hexValue(snapshot && snapshot->faultStatusValid,
                                                 snapshot ? snapshot->cfsr : 0) +
                             " hfsr=" + hexValue(snapshot && snapshot->faultStatusValid,
                                                 snapshot ? snapshot->hfsr : 0) +
                             " dfsr=" + hexValue(snapshot && snapshot->faultStatusValid,
                                                 snapshot ? snapshot->dfsr : 0) +
                             " bfar=" + hexValue(snapshot && snapshot->faultStatusValid,
                                                 snapshot ? snapshot->bfar : 0) +
                             " mmfar=" + hexValue(snapshot && snapshot->faultStatusValid,
                                                  snapshot ? snapshot->mmfar : 0);
  return Result::error(
      lockup ? ErrorCodes::kDapAlgorithmHaltUnknown : ErrorCodes::kDapControlTimeout,
      lockup ? std::string("Cortex-M target entered lockup while waiting for ") +
                   (halted ? "halt" : "run") + ";" + detail
             : std::string("Cortex-M target did not become ") +
                   (halted ? "halted" : "running") + " before the control timeout;" + detail);
}

Result CortexMDebug::readRegister(uint32_t index, uint32_t& value,
                                  DapTransferDiagnostics& diag,
                                  std::chrono::milliseconds timeout) {
  if (index > 16) return invalidRegister(index);

  uint32_t dhcsr = 0;
  Result result = readDhcsr(dhcsr, diag, timeout);
  if (!result.ok) return result;
  if ((dhcsr & kCoreDebugSHalt) == 0) {
    return Result::error(ErrorCodes::kInvalidState,
                         "Cortex-M core registers require a halted target");
  }

  result = writeWord(kCoreDebugDcrsr, index & kCoreDebugRegSelMask, diag, timeout);
  if (!result.ok) return result;
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  for (;;) {
    result = readDhcsr(dhcsr, diag, timeout);
    if (!result.ok) return result;
    if ((dhcsr & kCoreDebugSRegReady) != 0) break;
    if (std::chrono::steady_clock::now() >= deadline) {
      return Result::error(ErrorCodes::kDapControlTimeout,
                           "Cortex-M DCRSR read did not become ready before timeout");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return readWord(kCoreDebugDcrdr, value, diag, timeout);
}

Result CortexMDebug::fillState(uint32_t dhcsr, CortexMDebugState& state,
                               DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout) {
  state = CortexMDebugState{};
  state.dhcsr = dhcsr;
  state.halted = (dhcsr & kCoreDebugSHalt) != 0;
  if (!state.halted) return Result::success();
  state.pcValid = true;
  return readRegister(15, state.pc, diag, timeout);
}

Result CortexMDebug::captureSnapshot(CortexRegisterSnapshot& snapshot,
                                     DapTransferDiagnostics& diag,
                                     std::chrono::milliseconds timeout) {
  snapshot = CortexRegisterSnapshot{};
  uint32_t dhcsr = 0;
  Result result = readDhcsr(dhcsr, diag, timeout);
  if (!result.ok) return result;
  snapshot.dhcsrValid = true;
  snapshot.dhcsr = dhcsr;

  if ((dhcsr & kCoreDebugSHalt) != 0) {
    bool registersValid = true;
    const auto read = [&](uint32_t index, uint32_t& value) {
      const Result readResult = readRegister(index, value, diag, timeout);
      if (!readResult.ok) registersValid = false;
    };
    read(0, snapshot.r0);
    read(1, snapshot.r1);
    read(2, snapshot.r2);
    read(3, snapshot.r3);
    read(9, snapshot.r9);
    read(13, snapshot.sp);
    read(14, snapshot.lr);
    read(15, snapshot.pc);
    read(16, snapshot.xpsr);
    snapshot.registersValid = registersValid;
  }

  std::vector<uint32_t> faultWords;
  result = target_->readMemoryBlock(kCortexFaultCfsr, 5, faultWords, diag, timeout);
  if (result.ok && faultWords.size() == 5) {
    snapshot.faultStatusValid = true;
    snapshot.cfsr = faultWords[0];
    snapshot.hfsr = faultWords[1];
    snapshot.dfsr = faultWords[2];
    snapshot.mmfar = faultWords[3];
    snapshot.bfar = faultWords[4];
  }
  return Result::success();
}

Result CortexMDebug::getState(CortexMDebugState& state, DapTransferDiagnostics& diag,
                              std::chrono::milliseconds timeout) {
  uint32_t dhcsr = 0;
  const Result result = readDhcsr(dhcsr, diag, timeout);
  if (!result.ok) return result;
  return fillState(dhcsr, state, diag, timeout);
}

Result CortexMDebug::halt(CortexMDebugState& state, DapTransferDiagnostics& diag,
                          std::chrono::milliseconds timeout) {
  Result result = writeWord(kCoreDebugDhcsr, kCoreDebugDbgKey | kCoreDebugCDebugEn |
                                                kCoreDebugCHalt,
                            diag, timeout);
  if (!result.ok) return result;
  uint32_t dhcsr = 0;
  result = waitForHalt(true, dhcsr, diag, timeout);
  if (!result.ok) return result;
  return fillState(dhcsr, state, diag, timeout);
}

Result CortexMDebug::run(CortexMDebugState& state, DapTransferDiagnostics& diag,
                         std::chrono::milliseconds timeout) {
  Result result = writeWord(kCoreDebugDhcsr, kCoreDebugDbgKey | kCoreDebugCDebugEn,
                            diag, timeout);
  if (!result.ok) return result;
  uint32_t dhcsr = 0;
  result = waitForHalt(false, dhcsr, diag, timeout);
  if (!result.ok) return result;
  return fillState(dhcsr, state, diag, timeout);
}

Result CortexMDebug::reset(CortexMDebugState& state, DapTransferDiagnostics& diag,
                           std::chrono::milliseconds timeout) {
  Result result = writeWord(kCoreDebugAircr, kCoreDebugVectKey | kCoreDebugSysResetReq,
                            diag, timeout);
  if (!result.ok) return result;
  return getState(state, diag, timeout);
}

Result CortexMDebug::stepInstruction(CortexMDebugStepResult& step,
                                      DapTransferDiagnostics& diag,
                                      std::chrono::milliseconds timeout) {
  CortexMDebugState state;
  Result result = getState(state, diag, timeout);
  if (!result.ok) return result;
  if (!state.halted || !state.pcValid) {
    return Result::error(ErrorCodes::kInvalidState,
                         "Cortex-M instruction step requires a halted target");
  }
  step = CortexMDebugStepResult{};
  step.pcBefore = state.pc;
  result = writeWord(kCoreDebugDhcsr, kCoreDebugDbgKey | kCoreDebugCDebugEn |
                                             kCoreDebugCStep,
                     diag, timeout);
  if (!result.ok) return result;
  result = waitForHalt(true, step.dhcsr, diag, timeout);
  if (!result.ok) return result;
  result = readRegister(15, step.pcAfter, diag, timeout);
  if (!result.ok) return result;
  step.halted = true;
  return Result::success();
}

Result CortexMDebug::executeFlashAlgorithm(const FlashAlgorithmRunRequest& request,
                                           FlashAlgorithmRunResult& result,
                                           DapTransferDiagnostics& diag,
                                           std::chrono::milliseconds timeout,
                                           CortexMDebugDiagnostics* operationDiagnostics) {
  constexpr uint32_t kSramBase = 0x20000000u;
  constexpr uint32_t kSramEnd = 0x20020000u;
  const auto inSram = [=](uint32_t address, uint32_t size) {
    return address >= kSramBase && size <= kSramEnd - address;
  };
  if (operationDiagnostics) {
    *operationDiagnostics = CortexMDebugDiagnostics{};
    operationDiagnostics->operation = request.operation.empty() ? "flashAlgorithm" : request.operation;
    operationDiagnostics->entry = request.entry;
    operationDiagnostics->bkptAddress = request.bkptAddress;
    operationDiagnostics->algorithmAddress = request.algorithmAddress;
    operationDiagnostics->algorithmLength = request.code ? static_cast<uint32_t>(request.code->size()) : 0;
    operationDiagnostics->staticBase = request.staticBase;
    operationDiagnostics->stackPointer = request.stackPointer;
    operationDiagnostics->pageBufferAddress = request.pageBufferAddress;
    operationDiagnostics->targetAddress = request.targetAddress;
    operationDiagnostics->size = request.size;
  }
  if (!request.code || request.code->empty() || !request.data) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "Flash Algorithm code and page buffer data are required");
  }
  const uint32_t codeSize = static_cast<uint32_t>(request.code->size());
  const uint32_t pageBufferSize = (request.size + 3u) & ~3u;
  const uint32_t codeEnd = request.algorithmAddress + codeSize;
  const uint32_t pageBufferEnd = request.pageBufferAddress + pageBufferSize;
  const uint32_t stackBase = request.stackPointer - request.stackSize;
  const bool algorithmRangeValid = request.algorithmAddress <= kSramEnd &&
                                   codeSize <= kSramEnd - request.algorithmAddress;
  const bool stackRangeValid = request.stackSize != 0 &&
                               request.stackPointer >= kSramBase &&
                               request.stackPointer <= kSramEnd &&
                               request.stackSize <= request.stackPointer - kSramBase &&
                               inSram(stackBase, request.stackSize);
  const auto overlaps = [](uint32_t left, uint32_t leftEnd,
                           uint32_t right, uint32_t rightEnd) {
    return left < rightEnd && right < leftEnd;
  };
  const bool entryValid = (request.entry & 1u) == 0 && request.entry >= request.algorithmAddress &&
                          request.entry < codeEnd;
  const bool bkptValid = (request.bkptAddress & 1u) == 0 &&
                         request.bkptAddress >= request.algorithmAddress &&
                         request.bkptAddress + 1u < codeEnd;
  const bool pageBufferValid = request.pageBufferAddress <= kSramEnd &&
                               pageBufferSize <= kSramEnd - request.pageBufferAddress;
  const bool staticBaseValid = request.staticBase == 0 ||
                               (request.staticBase >= kSramBase &&
                                request.staticBase <= kSramEnd - 4u &&
                                (request.staticBase & 3u) == 0);
  const bool layoutOverlap = algorithmRangeValid && pageBufferValid && stackRangeValid &&
                             (overlaps(request.algorithmAddress, codeEnd,
                                       request.pageBufferAddress, pageBufferEnd) ||
                              overlaps(request.algorithmAddress, codeEnd, stackBase,
                                       request.stackPointer) ||
                              overlaps(request.pageBufferAddress, pageBufferEnd, stackBase,
                                       request.stackPointer));
  const bool bkptInstructionValid = bkptValid &&
                                    (*request.code)[request.bkptAddress - request.algorithmAddress] == 0x00 &&
                                    (*request.code)[request.bkptAddress - request.algorithmAddress + 1u] == 0xBE;
  if ((request.algorithmAddress & 3u) != 0 || (request.pageBufferAddress & 3u) != 0 ||
      (request.staticBase & 3u) != 0 || !algorithmRangeValid || !entryValid ||
      !pageBufferValid || !stackRangeValid || (request.stackPointer & 7u) != 0 ||
      !bkptValid || !bkptInstructionValid || !staticBaseValid || layoutOverlap) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "Flash Algorithm RAM layout, Thumb entry, BKPT, or stack alignment is invalid");
  }
  CortexMDebugState initial;
  Result operation = getState(initial, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  if (!initial.halted) {
    return Result::error(ErrorCodes::kInvalidState,
                         "Flash Algorithm execution requires a halted Cortex-M target");
  }
  auto bytesToWords = [](const std::vector<uint8_t>& bytes, uint8_t fill) {
    std::vector<uint32_t> words;
    words.reserve((bytes.size() + 3) / 4);
    for (size_t offset = 0; offset < bytes.size(); offset += 4) {
      uint32_t word = static_cast<uint32_t>(fill) * 0x01010101u;
      for (size_t byte = 0; byte < 4 && offset + byte < bytes.size(); ++byte) {
        word = (word & ~(0xFFu << (8 * byte))) |
               (static_cast<uint32_t>(bytes[offset + byte]) << (8 * byte));
      }
      words.push_back(word);
    }
    return words;
  };
  const std::vector<uint32_t> codeWords = bytesToWords(*request.code, 0x00);
  if (request.loadAlgorithmCode) {
    operation = target_->writeMemoryBlock(request.algorithmAddress, codeWords, diag,
                                          ioTimeout(timeout));
    if (!operation.ok) return operation;
  }
  if (request.loadPageData && !request.data->empty()) {
    const std::vector<uint32_t> dataWords = bytesToWords(*request.data, 0xFF);
    operation = target_->writeMemoryBlock(request.pageBufferAddress, dataWords, diag,
                                          ioTimeout(timeout));
    if (!operation.ok) return operation;
  }

  // The algorithm receives the CMSIS-Pack ABI arguments in R0-R3. The
  // helper intentionally exposes no general register-write RPC; this write
  // sequence exists only inside the bounded algorithm execution primitive.
  operation = writeCoreRegister(0, request.r0, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(1, request.r1, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(2, request.r2, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(3, request.r3, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(13, request.stackPointer, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(9, request.staticBase, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  // A RAM algorithm must start in Thumb state even when the target was
  // halted inside an application exception handler.
  operation = writeCoreRegister(16, kCortexXpsrThumb, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(14, request.bkptAddress | 1u, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  operation = writeCoreRegister(15, request.entry | 1u, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;

  if (operationDiagnostics) {
    (void)captureSnapshot(operationDiagnostics->before, diag, ioTimeout(timeout));
  }
  operation = clearFaultStatus(diag, ioTimeout(timeout));
  if (!operation.ok) return operation;

  operation = writeWord(kCoreDebugDhcsr, kCoreDebugDbgKey | kCoreDebugCDebugEn, diag,
                        ioTimeout(timeout));
  if (!operation.ok) return operation;
  uint32_t dhcsr = 0;
  operation = waitForHalt(true, dhcsr, diag, ioTimeout(timeout),
                          request.operation.c_str(), operationDiagnostics);
  if (!operation.ok) return operation;
  CortexMDebugState stopped;
  operation = fillState(dhcsr, stopped, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  if (!stopped.halted || !stopped.pcValid ||
      (stopped.pc != request.bkptAddress && stopped.pc != request.bkptAddress + 2u)) {
    return Result::error(ErrorCodes::kDapAlgorithmHaltUnknown,
                         "Flash Algorithm did not stop at the trusted BKPT address");
  }
  uint32_t returnCode = 0;
  operation = readRegister(0, returnCode, diag, ioTimeout(timeout));
  if (!operation.ok) return operation;
  result.returnCode = returnCode;
  result.pc = stopped.pc;
  result.dhcsr = stopped.dhcsr;
  // A successful call is already confirmed by the trusted BKPT PC, halted
  // DHCSR and R0 return code above. Full after-state is reserved for timeout
  // and lockup diagnostics in waitForHalt(); reading all core registers again
  // here adds hundreds of CMSIS-DAP transfers to every Flash operation.
  return Result::success();
}

}  // namespace cmsis_dap_helper
