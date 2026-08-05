#include "cmsis_dap_target.h"

#include <algorithm>
#include <thread>

namespace cmsis_dap_helper {

namespace {

// Number of words until the next 1 KiB boundary of a 4-byte aligned address.
uint32_t wordsUntilBoundary(uint32_t address) {
  const uint32_t offsetInPage = address & (kMemApBoundaryBytes - 1);
  return (kMemApBoundaryBytes - offsetInPage) / 4;
}

const char* ackNameForTarget(const std::string& errorCode) {
  if (errorCode == ErrorCodes::kDapAckFault) return "FAULT";
  if (errorCode == ErrorCodes::kDapAckNoAck) return "NO_ACK";
  return "WAIT";
}

}  // namespace

Result CmsisDapTarget::readDp(uint8_t reg, uint32_t& value, DapTransferDiagnostics& diag,
                              std::chrono::milliseconds timeout) {
  if (reg > 0x0F || (reg & 0x03) != 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "DP register address 0x" +
                             std::to_string(reg) + " must be 4-byte aligned and <= 0x0C");
  }
  std::vector<DapTransferItem> items(1);
  items[0].ap = false;
  items[0].rnw = true;
  items[0].addr = static_cast<uint8_t>((reg >> 2) & 0x03);
  ++diag.packets;
  const Result result = protocol_->dapTransfer(0, items, timeout);
  if (!result.ok) return result;
  if (!items[0].readDataValid) {
    return Result::error(ErrorCodes::kInternalError, "DP read returned no data");
  }
  value = items[0].readData;
  return Result::success();
}

Result CmsisDapTarget::writeDp(uint8_t reg, uint32_t value, DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout) {
  if (reg > 0x0F || (reg & 0x03) != 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "DP register address must be 4-byte aligned and <= 0x0C");
  }
  std::vector<DapTransferItem> items(1);
  items[0].ap = false;
  items[0].rnw = false;
  items[0].addr = static_cast<uint8_t>((reg >> 2) & 0x03);
  items[0].value = value;
  ++diag.packets;
  return protocol_->dapTransfer(0, items, timeout);
}

Result CmsisDapTarget::clearStickyErrors(DapTransferDiagnostics& diag,
                                         std::chrono::milliseconds timeout) {
  // OpenOCD clears SWD sticky state with an ordinary DP ABORT transfer. Use
  // that path here so a DAPLink v1 probe cannot hide the underlying SWD ACK:
  // its DAP_WriteABORT handler always reports DAP_OK even when SWD_Transfer
  // itself returned WAIT/FAULT/NO_ACK.
  return writeDp(kDpRegAbortIdcode, kAbortClearAll, diag, timeout);
}

Result CmsisDapTarget::initializeDebugPower(DapTransferDiagnostics& diag,
                                             std::chrono::milliseconds timeout) {
  Result result = clearStickyErrors(diag, timeout);
  if (!result.ok) return result;
  // Match OpenOCD dap_dp_init(): the first CTRL/STAT write requests both
  // power domains while clearing SSTICKYERR/SSTICKYORUN, then a readback is
  // followed by a clean power-request write before ACK polling.
  result = writeDp(kDpRegCtrlStat,
                   kCtrlStatPowerupRequest | kCtrlStatStickyErr | kCtrlStatStickyOrun,
                   diag, timeout);
  if (!result.ok) return result;
  uint32_t ctrlStat = 0;
  result = readDp(kDpRegCtrlStat, ctrlStat, diag, timeout);
  if (!result.ok) return result;
  result = writeDp(kDpRegCtrlStat, kCtrlStatPowerupRequest, diag, timeout);
  if (!result.ok) return result;

  const auto deadline = std::chrono::steady_clock::now() + timeout;
  for (;;) {
    ctrlStat = 0;
    result = readDp(kDpRegCtrlStat, ctrlStat, diag, timeout);
    if (!result.ok) return result;
    if ((ctrlStat & kCtrlStatPowerupAck) == kCtrlStatPowerupAck) return Result::success();
    if (std::chrono::steady_clock::now() >= deadline) {
      return Result::error(ErrorCodes::kDapControlTimeout,
                           "SW-DP debug/system power-up ACK did not arrive before timeout");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

Result CmsisDapTarget::readApCore(uint8_t addr, uint32_t& value, DapTransferDiagnostics& diag,
                                  std::chrono::milliseconds timeout) {
  if (addr > 0x0F || (addr & 0x03) != 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "AP register address must be 4-byte aligned and <= 0x0C");
  }
  std::vector<DapTransferItem> items(2);
  items[0].ap = true;
  items[0].rnw = true;
  items[0].addr = static_cast<uint8_t>((addr >> 2) & 0x03);
  // The second read goes to DP RDBUFF, which returns the data captured by
  // the AP read (AP reads are pipelined; the direct response of an AP read
  // carries the previous access's data).
  items[1].ap = false;
  items[1].rnw = true;
  items[1].addr = static_cast<uint8_t>((kDpRegRdbuff >> 2) & 0x03);
  ++diag.packets;
  const Result result = protocol_->dapTransfer(0, items, timeout);
  if (!result.ok) return result;
  if (!items[1].readDataValid) {
    return Result::error(ErrorCodes::kInternalError, "AP read returned no RDBUFF data");
  }
  value = items[1].readData;
  return Result::success();
}

Result CmsisDapTarget::readAp(uint8_t addr, uint32_t& value, DapTransferDiagnostics& diag,
                              std::chrono::milliseconds timeout) {
  if (addr != kApRegCsw && addr != kApRegTar && addr != kApRegDrw) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "AP bank-0 register 0x" + std::to_string(addr) +
                             " is not readable in this stage (CSW/TAR/DRW only)");
  }
  // SELECT: APSEL 0, APBANKSEL 0.
  Result selectResult = writeDp(kDpRegSelect, 0, diag, timeout);
  if (!selectResult.ok) return selectResult;
  return readApCore(addr, value, diag, timeout);
}

Result CmsisDapTarget::writeAp(uint8_t addr, uint32_t value, DapTransferDiagnostics& diag,
                               std::chrono::milliseconds timeout) {
  if (addr != kApRegCsw && addr != kApRegTar && addr != kApRegDrw) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "AP bank-0 register 0x" + std::to_string(addr) +
                             " is not writable in this stage (CSW/TAR/DRW only)");
  }
  Result selectResult = writeDp(kDpRegSelect, 0, diag, timeout);
  if (!selectResult.ok) return selectResult;
  std::vector<DapTransferItem> items(1);
  items[0].ap = true;
  items[0].rnw = false;
  items[0].addr = static_cast<uint8_t>((addr >> 2) & 0x03);
  items[0].value = value;
  ++diag.packets;
  return protocol_->dapTransfer(0, items, timeout);
}

Result CmsisDapTarget::setupMemoryAccess(uint32_t address,
                                         DapTransferDiagnostics& diag,
                                         std::chrono::milliseconds timeout) {
  std::vector<DapTransferItem> items(3);
  items[0].ap = false;
  items[0].rnw = false;
  items[0].addr = static_cast<uint8_t>((kDpRegSelect >> 2) & 0x03);
  items[0].value = 0;
  items[1].ap = true;
  items[1].rnw = false;
  items[1].addr = static_cast<uint8_t>((kApRegCsw >> 2) & 0x03);
  items[1].value = kApCsw32Auto;
  items[2].ap = true;
  items[2].rnw = false;
  items[2].addr = static_cast<uint8_t>((kApRegTar >> 2) & 0x03);
  items[2].value = address;
  ++diag.packets;
  return protocol_->dapTransfer(0, items, timeout);
}

Result CmsisDapTarget::readMemoryFirstWord(uint32_t address, uint32_t& value,
                                           DapTransferDiagnostics& diag,
                                           std::chrono::milliseconds timeout) {
  std::vector<DapTransferItem> items(5);
  items[0].ap = false;
  items[0].rnw = false;
  items[0].addr = static_cast<uint8_t>((kDpRegSelect >> 2) & 0x03);
  items[0].value = 0;
  items[1].ap = true;
  items[1].rnw = false;
  items[1].addr = static_cast<uint8_t>((kApRegCsw >> 2) & 0x03);
  items[1].value = kApCsw32Auto;
  items[2].ap = true;
  items[2].rnw = false;
  items[2].addr = static_cast<uint8_t>((kApRegTar >> 2) & 0x03);
  items[2].value = address;
  items[3].ap = true;
  items[3].rnw = true;
  items[3].addr = static_cast<uint8_t>((kApRegDrw >> 2) & 0x03);
  items[4].ap = false;
  items[4].rnw = true;
  items[4].addr = static_cast<uint8_t>((kDpRegRdbuff >> 2) & 0x03);
  ++diag.packets;
  const Result result = protocol_->dapTransfer(0, items, timeout);
  if (!result.ok) return result;
  if (!items[4].readDataValid) {
    return Result::error(ErrorCodes::kInternalError,
                         "batched memory read returned no RDBUFF data");
  }
  value = items[4].readData;
  return Result::success();
}

Result CmsisDapTarget::writeMemoryWordSingle(uint32_t address, uint32_t value,
                                              DapTransferDiagnostics& diag,
                                              std::chrono::milliseconds timeout) {
  uint32_t attempt = 0;
  for (;;) {
    // Some CMSIS-DAP v1 firmwares implement AP DRW block reads correctly but
    // reject DAP_TransferBlock writes. CoreDebug control writes are one word and
    // use one mixed DAP_Transfer to keep this private path interoperable.
    std::vector<DapTransferItem> items(4);
    items[0].ap = false;
    items[0].rnw = false;
    items[0].addr = static_cast<uint8_t>((kDpRegSelect >> 2) & 0x03);
    items[0].value = 0;
    items[1].ap = true;
    items[1].rnw = false;
    items[1].addr = static_cast<uint8_t>((kApRegCsw >> 2) & 0x03);
    items[1].value = kApCsw32Auto;
    items[2].ap = true;
    items[2].rnw = false;
    items[2].addr = static_cast<uint8_t>((kApRegTar >> 2) & 0x03);
    items[2].value = address;
    items[3].ap = true;
    items[3].rnw = false;
    items[3].addr = static_cast<uint8_t>((kApRegDrw >> 2) & 0x03);
    items[3].value = value;
    uint8_t completed = 0;
    ++diag.packets;
    const Result transfer = protocol_->dapTransfer(0, items, timeout, &completed);
    if (transfer.ok) return transfer;
    if (transfer.errorCode != ErrorCodes::kDapAckWait &&
        transfer.errorCode != ErrorCodes::kDapAckFault) {
      return transfer;
    }
    if (completed >= items.size()) {
      return Result::error(
          ErrorCodes::kOutcomeUnknown,
          "CoreDebug single write completion is unknown: " + transfer.message +
              "; completed=" + std::to_string(completed) + "/" +
              std::to_string(items.size()) + " (not retried)");
    }
    if (transfer.errorCode == ErrorCodes::kDapAckFault) {
      ++diag.faultClears;
      const Result clearResult = clearStickyErrors(diag, timeout);
      if (!clearResult.ok) return clearResult;
    }
    if (++attempt > kMaxTransferRetries) {
      return Result::error(transfer.errorCode,
                           "CoreDebug single write failed after " + std::to_string(attempt) +
                               " attempts: " + transfer.message);
    }
    ++diag.waitRetries;
  }
}

Result CmsisDapTarget::readMemoryBlock(uint32_t address, uint32_t wordCount,
                                       std::vector<uint32_t>& words,
                                       DapTransferDiagnostics& diag,
                                       std::chrono::milliseconds timeout) {
  words.clear();
  if (wordCount == 0) {
    return Result::success();
  }
  if ((address & 0x03) != 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "readMemoryBlock requires a 4-byte aligned address, got 0x" +
                             std::to_string(address));
  }
  // Each DAP_TransferBlock read response is
  // [0x06][count16][status][4*N data]: the response carries 4 header bytes,
  // so at most (packetSize - 4) / 4 total words fit into one logical chunk.
  // The first word of every chunk is obtained through [AP DRW][DP RDBUFF],
  // leaving chunk - 1 words for the block command.
  const uint32_t maxBlockRead = packetSize_ >= 8 ? (packetSize_ - 4) / 4 : 1;

  words.reserve(wordCount);
  uint32_t position = address;
  uint32_t remaining = wordCount;
  while (remaining > 0) {
    const uint32_t chunk =
        std::min(remaining, std::min(maxBlockRead, wordsUntilBoundary(position)));
    ++diag.chunks;

    uint32_t attempt = 0;
    for (;;) {
      // AP reads are pipelined: the [AP DRW read][DP RDBUFF] pair returns the
      // word at the current TAR and advances TAR. Keep that value as the
      // first word; a following block read starts at the next word.
      uint32_t firstWord = 0;
      Result dummyResult = readMemoryFirstWord(position, firstWord, diag, timeout);
      if (!dummyResult.ok) {
        if (dummyResult.errorCode == ErrorCodes::kDapAckFault) {
          // FAULT: the sticky error must be cleared before any retry.
          diag.faultClears++;
          Result clearResult = clearStickyErrors(diag, timeout);
          if (!clearResult.ok) return clearResult;
        } else if (dummyResult.errorCode != ErrorCodes::kDapAckWait) {
          return dummyResult;
        }
        if (++attempt > kMaxTransferRetries) {
          return Result::error(
              dummyResult.errorCode == ErrorCodes::kDapAckFault
                  ? ErrorCodes::kDapAckFault
                  : ErrorCodes::kDapAckWait,
              "readMemoryBlock chunk at 0x" + std::to_string(position) +
                  " stayed " + ackNameForTarget(dummyResult.errorCode) + " after " +
                  std::to_string(attempt) + " attempts");
        }
        diag.waitRetries++;
        continue;
      }

      std::vector<uint32_t> chunkWords;
      chunkWords.reserve(chunk);
      chunkWords.push_back(firstWord);
      if (chunk > 1) {
        const uint16_t blockWordCount = static_cast<uint16_t>(chunk - 1);
        std::vector<uint32_t> blockWords;
        uint8_t ack = 0;
        uint16_t completed = 0;
        ++diag.packets;
        ++diag.blockReads;
        // AP DRW read: APnDP=1, RnW=1, A[3:2]=DRW(3).
        const uint8_t blockRequest =
            static_cast<uint8_t>(kRequestApnDp | kRequestRnw | ((kApRegDrw >> 2) << 2));
        const Result blockResult = protocol_->dapTransferBlockRead(
            0, blockRequest, blockWordCount, blockWords, ack, completed,
            timeout);
        if (!blockResult.ok) {
          if (blockResult.errorCode == ErrorCodes::kDapAckFault) {
            diag.faultClears++;
            Result clearResult = clearStickyErrors(diag, timeout);
            if (!clearResult.ok) return clearResult;
          }
          if (blockResult.errorCode != ErrorCodes::kDapAckWait &&
              blockResult.errorCode != ErrorCodes::kDapAckFault) {
            return blockResult;
          }
          if (++attempt > kMaxTransferRetries) {
            return Result::error(
                blockResult.errorCode,
                "readMemoryBlock chunk at 0x" + std::to_string(position) + " failed after " +
                    std::to_string(attempt) + " attempts: " + blockResult.message);
          }
          diag.waitRetries++;
          continue;
        }
        if (blockWords.size() != blockWordCount) {
          return Result::error(ErrorCodes::kInternalError,
                               "block read returned " + std::to_string(blockWords.size()) +
                                   " words for " + std::to_string(blockWordCount));
        }
        chunkWords.insert(chunkWords.end(), blockWords.begin(), blockWords.end());
      }
      words.insert(words.end(), chunkWords.begin(), chunkWords.end());
      break;
    }
    position += chunk * 4;
    remaining -= chunk;
  }
  return Result::success();
}

Result CmsisDapTarget::readMemory(uint32_t address, uint32_t size, std::vector<uint8_t>& bytes,
                                  DapTransferDiagnostics& diag) {
  bytes.clear();
  if (size == 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest, "readMemory size must be > 0");
  }
  const uint64_t end = static_cast<uint64_t>(address) + size;
  if (end > 0x100000000ull) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "readMemory range [0x" + std::to_string(address) + ", " +
                             std::to_string(size) + ") overflows the 32-bit address space");
  }
  const uint32_t firstWord = address & ~3u;
  const uint32_t lastWord = static_cast<uint32_t>((end - 1) / 4);  // inclusive
  const uint32_t wordCount = lastWord - firstWord / 4 + 1;
  std::vector<uint32_t> words;
  const Result blockResult = readMemoryBlock(firstWord, wordCount, words, diag);
  if (!blockResult.ok) return blockResult;
  bytes.resize(size);
  for (uint32_t i = 0; i < size; ++i) {
    const uint64_t byteAddress = static_cast<uint64_t>(address) + i;
    const uint32_t word = words[static_cast<uint32_t>(byteAddress - firstWord) / 4];
    bytes[i] = static_cast<uint8_t>(word >> (8 * ((byteAddress - firstWord) & 0x03)));
  }
  return Result::success();
}

Result CmsisDapTarget::writeMemoryBlock(uint32_t address, const std::vector<uint32_t>& words,
                                        DapTransferDiagnostics& diag,
                                        std::chrono::milliseconds timeout) {
  if (words.empty()) {
    return Result::success();
  }
  if ((address & 0x03) != 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "writeMemoryBlock requires a 4-byte aligned address, got 0x" +
                             std::to_string(address));
  }
  // Each DAP_TransferBlock write request is
  // [0x06][dap][count16][request][4*N data]: at most (packetSize - 5) / 4
  // words fit into one command; the write response is a fixed 4 bytes.
  const uint32_t maxBlockWrite = packetSize_ >= 9 ? (packetSize_ - 5) / 4 : 1;

  uint32_t position = address;
  size_t offset = 0;
  bool setupRequired = true;
  while (offset < words.size()) {
    const size_t chunk = std::min<size_t>(
        std::min<size_t>(words.size() - offset, maxBlockWrite), wordsUntilBoundary(position));
    ++diag.chunks;

    uint32_t attempt = 0;
    for (;;) {
      if (setupRequired) {
        const Result setupResult = setupMemoryAccess(position, diag, timeout);
        if (!setupResult.ok) return setupResult;
        setupRequired = false;
      }

      std::vector<uint32_t> chunkWords(words.begin() + static_cast<long>(offset),
                                       words.begin() + static_cast<long>(offset + chunk));
      uint8_t ack = 0;
      uint16_t completed = 0;
      ++diag.packets;
      ++diag.blockWrites;
      // AP DRW write: APnDP=1, RnW=0, A[3:2]=DRW(3).
      const uint8_t blockRequest =
          static_cast<uint8_t>(kRequestApnDp | ((kApRegDrw >> 2) << 2));
      Result blockResult = protocol_->dapTransferBlockWrite(
          0, blockRequest, chunkWords, ack, completed,
          timeout);
      if (blockResult.ok) break;
      // Never retry when the write's completion state is unknown. Only an
      // explicit WAIT/FAULT ACK (write not accepted) may be retried.
      if (blockResult.errorCode != ErrorCodes::kDapAckWait &&
          blockResult.errorCode != ErrorCodes::kDapAckFault) {
        return blockResult;
      }
      if (completed != 0) {
        return Result::error(
            ErrorCodes::kOutcomeUnknown,
            "writeMemoryBlock chunk at 0x" + std::to_string(position) +
                " has unknown completion: " + blockResult.message +
                "; completed=" + std::to_string(completed) + "/" +
                std::to_string(chunk) + " (not retried)");
      }
      if (blockResult.errorCode == ErrorCodes::kDapAckFault) {
        diag.faultClears++;
        Result clearResult = clearStickyErrors(diag, timeout);
        if (!clearResult.ok) return clearResult;
      }
      setupRequired = true;
      if (++attempt > kMaxTransferRetries) {
        return Result::error(blockResult.errorCode,
                             "writeMemoryBlock chunk at 0x" + std::to_string(position) +
                                 " failed after " + std::to_string(attempt) + " attempts: " +
                                 blockResult.message);
      }
      diag.waitRetries++;
    }
    position += static_cast<uint32_t>(chunk * 4);
    offset += chunk;
    if ((position & (kMemApBoundaryBytes - 1u)) == 0) setupRequired = true;
  }
  return Result::success();
}

}  // namespace cmsis_dap_helper
