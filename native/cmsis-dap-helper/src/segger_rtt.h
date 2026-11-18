#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "cmsis_dap_target.h"
#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

using RttClockNow = std::chrono::steady_clock::time_point (*)();

class RttMemory {
 public:
  virtual ~RttMemory() = default;
  virtual Result read(uint32_t address, uint32_t size, std::vector<uint8_t>& bytes,
                      DapTransferDiagnostics& diagnostics) = 0;
  virtual Result write(uint32_t address, const std::vector<uint8_t>& bytes,
                       DapTransferDiagnostics& diagnostics) = 0;
};

struct RttMemoryRange {
  uint32_t address = 0;
  uint32_t size = 0;
};

enum class RttChannelDirection {
  Up,
  Down,
};

enum class RttDescriptorStatus {
  Valid,
  Unused,
  Corrupt,
};

enum class RttNameStatus {
  Ok,
  Null,
  Empty,
  ShortRead,
  Unterminated,
  InvalidAddress,
  ReadFailed,
  None,
};

struct RttChannelDescriptor {
  RttChannelDirection direction = RttChannelDirection::Up;
  uint32_t index = 0;
  uint32_t descriptorAddress = 0;
  bool configured = false;
  bool valid = false;
  RttDescriptorStatus status = RttDescriptorStatus::Unused;
  std::string name;
  uint32_t nameAddress = 0;
  RttNameStatus nameStatus = RttNameStatus::None;
  std::string nameError;
  bool duplicateName = false;
  uint32_t bufferAddress = 0;
  uint32_t bufferSize = 0;
  uint32_t wrOff = 0;
  uint32_t rdOff = 0;
  uint32_t flags = 0;
  uint32_t mode = 0;
  std::string errorCode;
  std::string errorMessage;
};

struct RttEnumerationResult {
  uint32_t controlBlockAddress = 0;
  uint32_t maxUpBuffers = 0;
  uint32_t maxDownBuffers = 0;
  std::vector<RttChannelDescriptor> upBuffers;
  std::vector<RttChannelDescriptor> downBuffers;
  std::vector<std::string> duplicateUpNames;
  std::vector<std::string> duplicateDownNames;
  uint32_t validUpCount = 0;
  uint32_t validDownCount = 0;
  uint32_t corruptCount = 0;
  uint32_t unusedCount = 0;
};

struct RttReadResult {
  std::vector<uint8_t> bytes;
  uint32_t controlBlockAddress = 0;
  uint32_t bufferIndex = 0;
  uint32_t descriptorAddress = 0;
  uint32_t bufferAddress = 0;
  uint32_t bufferSize = 0;
  uint32_t wrOff = 0;
  uint32_t rdOff = 0;
  uint32_t flags = 0;
  uint32_t mode = 0;
  uint32_t committedRdOff = 0;
  uint32_t requestedBytes = 0;
  uint32_t readBytes = 0;
  uint32_t committedBytes = 0;
  bool wrapped = false;
  bool overrun = false;
  bool writerAdvanced = false;
};

class SeggerRttReader {
 public:
  explicit SeggerRttReader(bool validateBufferFlags = true)
      : validateBufferFlags_(validateBufferFlags) {}

  static const std::vector<RttMemoryRange>& defaultSramRanges();
  static Result validateMemoryRanges(const std::vector<RttMemoryRange>& ranges,
                                     bool allowEmpty, const char* label);

  Result start(RttMemory& memory, uint32_t controlBlockAddress,
               DapTransferDiagnostics& diagnostics);
  Result start(RttMemory& memory, uint32_t controlBlockAddress,
               const std::vector<RttMemoryRange>& ramRanges,
               DapTransferDiagnostics& diagnostics);
  Result stop();
  Result read(RttMemory& memory, uint32_t bufferIndex, uint32_t maxBytes,
              RttReadResult& output, DapTransferDiagnostics& diagnostics);
  Result enumerate(RttMemory& memory, uint32_t controlBlockAddress,
                   const std::vector<RttMemoryRange>& ramRanges,
                   const std::vector<RttMemoryRange>& roRanges,
                   RttEnumerationResult& output,
                   DapTransferDiagnostics& diagnostics,
                   std::chrono::milliseconds timeout = std::chrono::milliseconds(2000),
                   std::optional<std::chrono::steady_clock::time_point> startTime = std::nullopt,
                   RttClockNow clockNow = nullptr) const;

  bool started() const { return started_; }
  uint32_t controlBlockAddress() const { return controlBlockAddress_; }
  const std::vector<RttMemoryRange>& ramRanges() const { return ramRanges_; }

 private:
  Result readControlBlock(RttMemory& memory, uint32_t controlBlockAddress,
                          const std::vector<RttMemoryRange>& ramRanges,
                          std::vector<uint8_t>& header,
                          uint32_t& maxUpBuffers, uint32_t& maxDownBuffers,
                          DapTransferDiagnostics& diagnostics) const;
  Result readBuffer(RttMemory& memory, uint32_t bufferIndex, uint32_t maxUpBuffers,
                    std::vector<uint8_t>& descriptor, RttReadResult& output,
                    DapTransferDiagnostics& diagnostics);

  bool started_ = false;
  uint32_t controlBlockAddress_ = 0;
  std::vector<RttMemoryRange> ramRanges_;
  bool validateBufferFlags_ = true;
};

}  // namespace cmsis_dap_helper
