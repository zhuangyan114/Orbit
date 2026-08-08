#pragma once

#include <cstdint>
#include <vector>

#include "cmsis_dap_target.h"
#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

class RttMemory {
 public:
  virtual ~RttMemory() = default;
  virtual Result read(uint32_t address, uint32_t size, std::vector<uint8_t>& bytes,
                      DapTransferDiagnostics& diagnostics) = 0;
  virtual Result write(uint32_t address, const std::vector<uint8_t>& bytes,
                       DapTransferDiagnostics& diagnostics) = 0;
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

  Result start(RttMemory& memory, uint32_t controlBlockAddress,
               DapTransferDiagnostics& diagnostics);
  Result stop();
  Result read(RttMemory& memory, uint32_t bufferIndex, uint32_t maxBytes,
              RttReadResult& output, DapTransferDiagnostics& diagnostics);

  bool started() const { return started_; }
  uint32_t controlBlockAddress() const { return controlBlockAddress_; }

 private:
  Result readControlBlock(RttMemory& memory, std::vector<uint8_t>& header,
                          uint32_t& maxUpBuffers, DapTransferDiagnostics& diagnostics);
  Result readBuffer(RttMemory& memory, uint32_t bufferIndex, uint32_t maxUpBuffers,
                    std::vector<uint8_t>& descriptor, RttReadResult& output,
                    DapTransferDiagnostics& diagnostics);

  bool started_ = false;
  uint32_t controlBlockAddress_ = 0;
  bool validateBufferFlags_ = true;
};

}  // namespace cmsis_dap_helper
