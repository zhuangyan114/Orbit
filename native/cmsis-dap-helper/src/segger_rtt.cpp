#include "segger_rtt.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <string>

namespace cmsis_dap_helper {
namespace {

constexpr uint32_t kSramBase = 0x20000000u;
constexpr uint32_t kSramEnd = 0x20020000u;
constexpr uint32_t kControlHeaderSize = 24u;
constexpr uint32_t kBufferDescriptorSize = 24u;
constexpr uint32_t kMaxRttBuffers = 64u;
constexpr uint32_t kMaxReadBytes = 65536u;
constexpr uint32_t kRttModeMask = 0x03u;
constexpr uint32_t kRttModeBlockIfFifoFull = 0x02u;
constexpr char kMagic[] = "SEGGER RTT";

bool inSram(uint64_t address, uint64_t size) {
  return address >= kSramBase && address <= kSramEnd && size <= static_cast<uint64_t>(kSramEnd) - address;
}

uint32_t readLe32(const std::vector<uint8_t>& bytes, size_t offset) {
  return static_cast<uint32_t>(bytes[offset])
      | (static_cast<uint32_t>(bytes[offset + 1]) << 8)
      | (static_cast<uint32_t>(bytes[offset + 2]) << 16)
      | (static_cast<uint32_t>(bytes[offset + 3]) << 24);
}

std::vector<uint8_t> le32(uint32_t value) {
  return {
    static_cast<uint8_t>(value & 0xFFu),
    static_cast<uint8_t>((value >> 8) & 0xFFu),
    static_cast<uint8_t>((value >> 16) & 0xFFu),
    static_cast<uint8_t>((value >> 24) & 0xFFu),
  };
}

Result invalid(const char* code, const std::string& message) {
  return Result::error(code, message);
}

Result memoryReadFailure(const Result& result, const char* operation) {
  return Result::error(ErrorCodes::kRttMemoryReadFailed,
                       std::string(operation) + " failed: " + result.errorCode + ": " + result.message);
}

Result memoryWriteFailure(const Result& result) {
  return Result::error(ErrorCodes::kRttMemoryWriteFailed,
                       "RTT RdOff write failed: " + result.errorCode + ": " + result.message);
}

}  // namespace

Result SeggerRttReader::readControlBlock(RttMemory& memory, std::vector<uint8_t>& header,
                                         uint32_t& maxUpBuffers,
                                         DapTransferDiagnostics& diagnostics) {
  if (!inSram(controlBlockAddress_, kControlHeaderSize) || (controlBlockAddress_ & 0x03u) != 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block address is outside STM32F4 SRAM");
  }
  const Result result = memory.read(controlBlockAddress_, kControlHeaderSize, header, diagnostics);
  if (!result.ok) return memoryReadFailure(result, "RTT Control Block read");
  if (header.size() != kControlHeaderSize || std::memcmp(header.data(), kMagic, sizeof(kMagic) - 1) != 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block magic is not SEGGER RTT");
  }
  const uint32_t maxDownBuffers = readLe32(header, 20);
  maxUpBuffers = readLe32(header, 16);
  if (maxUpBuffers == 0 || maxUpBuffers > kMaxRttBuffers || maxDownBuffers > kMaxRttBuffers) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block buffer counts are invalid");
  }
  const uint64_t descriptorsEnd = static_cast<uint64_t>(controlBlockAddress_) + kControlHeaderSize
      + (static_cast<uint64_t>(maxUpBuffers) + maxDownBuffers) * kBufferDescriptorSize;
  if (!inSram(controlBlockAddress_, descriptorsEnd - controlBlockAddress_)) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block descriptors exceed STM32F4 SRAM");
  }
  return Result::success();
}

Result SeggerRttReader::readBuffer(RttMemory& memory, uint32_t bufferIndex, uint32_t maxUpBuffers,
                                   std::vector<uint8_t>& descriptor, RttReadResult& output,
                                   DapTransferDiagnostics& diagnostics) {
  if (bufferIndex >= maxUpBuffers) {
    return invalid(ErrorCodes::kRttInvalidBufferIndex, "RTT Up Buffer index is out of range");
  }
  const uint64_t address = static_cast<uint64_t>(controlBlockAddress_) + kControlHeaderSize
      + static_cast<uint64_t>(bufferIndex) * kBufferDescriptorSize;
  if (!inSram(address, kBufferDescriptorSize)) {
    return invalid(ErrorCodes::kRttInvalidBufferLayout, "RTT Up Buffer descriptor exceeds STM32F4 SRAM");
  }
  output.descriptorAddress = static_cast<uint32_t>(address);
  const Result result = memory.read(output.descriptorAddress, kBufferDescriptorSize, descriptor, diagnostics);
  if (!result.ok) return memoryReadFailure(result, "RTT Up Buffer descriptor read");
  if (descriptor.size() != kBufferDescriptorSize) {
    return invalid(ErrorCodes::kRttInvalidBufferLayout, "RTT Up Buffer descriptor response is short");
  }
  output.bufferAddress = readLe32(descriptor, 4);
  output.bufferSize = readLe32(descriptor, 8);
  output.wrOff = readLe32(descriptor, 12);
  output.rdOff = readLe32(descriptor, 16);
  output.flags = readLe32(descriptor, 20);
  output.mode = output.flags & kRttModeMask;
  if (validateBufferFlags_ &&
      ((output.flags & ~kRttModeMask) != 0 || output.mode > kRttModeBlockIfFifoFull)) {
    return invalid(ErrorCodes::kRttInvalidBufferFlags,
                   "RTT Up Buffer Flags contain an unknown mode or reserved bits"
                   " flags=" + std::to_string(output.flags)
                   + " mode=" + std::to_string(output.mode)
                   + " bufferIndex=" + std::to_string(bufferIndex)
                   + " descriptorAddress=" + std::to_string(output.descriptorAddress)
                   + " bufferAddress=" + std::to_string(output.bufferAddress)
                   + " bufferSize=" + std::to_string(output.bufferSize)
                   + " wrOff=" + std::to_string(output.wrOff)
                   + " rdOff=" + std::to_string(output.rdOff));
  }
  if (output.bufferAddress == 0 || output.bufferSize == 0 ||
      !inSram(output.bufferAddress, output.bufferSize) ||
      output.wrOff >= output.bufferSize || output.rdOff >= output.bufferSize) {
    return invalid(ErrorCodes::kRttInvalidBufferLayout,
                   "RTT Up Buffer pointer, size, or offsets are invalid"
                   " address=" + std::to_string(output.bufferAddress)
                   + " size=" + std::to_string(output.bufferSize)
                   + " wrOff=" + std::to_string(output.wrOff)
                   + " rdOff=" + std::to_string(output.rdOff));
  }
  return Result::success();
}

Result SeggerRttReader::start(RttMemory& memory, uint32_t controlBlockAddress,
                              DapTransferDiagnostics& diagnostics) {
  if (controlBlockAddress == 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block address is invalid");
  }
  const bool wasStarted = started_;
  const uint32_t previousAddress = controlBlockAddress_;
  controlBlockAddress_ = controlBlockAddress;
  std::vector<uint8_t> header;
  uint32_t maxUpBuffers = 0;
  const Result result = readControlBlock(memory, header, maxUpBuffers, diagnostics);
  if (!result.ok) {
    controlBlockAddress_ = previousAddress;
    started_ = wasStarted;
    return result;
  }
  started_ = true;
  return Result::success();
}

Result SeggerRttReader::stop() {
  started_ = false;
  controlBlockAddress_ = 0;
  return Result::success();
}

Result SeggerRttReader::read(RttMemory& memory, uint32_t bufferIndex, uint32_t maxBytes,
                             RttReadResult& output, DapTransferDiagnostics& diagnostics) {
  output = RttReadResult{};
  output.controlBlockAddress = controlBlockAddress_;
  output.bufferIndex = bufferIndex;
  output.requestedBytes = maxBytes;
  if (!started_) return invalid(ErrorCodes::kRttStopped, "RTT is not started");
  if (maxBytes == 0 || maxBytes > kMaxReadBytes) {
    return invalid(ErrorCodes::kRttInvalidBufferLayout, "RTT read size is outside 1..65536");
  }

  std::vector<uint8_t> header;
  uint32_t maxUpBuffers = 0;
  Result result = readControlBlock(memory, header, maxUpBuffers, diagnostics);
  if (!result.ok) return result;

  std::vector<uint8_t> descriptor;
  result = readBuffer(memory, bufferIndex, maxUpBuffers, descriptor, output, diagnostics);
  if (!result.ok) return result;
  output.committedRdOff = output.rdOff;
  if (output.wrOff == output.rdOff) return Result::success();

  const uint32_t available = output.wrOff > output.rdOff
      ? output.wrOff - output.rdOff
      : output.bufferSize - output.rdOff + output.wrOff;
  if (available > output.bufferSize) {
    output.overrun = true;
    return invalid(ErrorCodes::kRttBufferOverrun, "RTT Up Buffer available range exceeds its size");
  }
  const uint32_t requested = std::min(maxBytes, available);
  const uint32_t tail = output.bufferSize - output.rdOff;
  const uint32_t firstSize = std::min(requested, tail);
  const uint32_t secondSize = requested - firstSize;
  output.wrapped = secondSize > 0;
  std::vector<uint8_t> first;
  result = memory.read(output.bufferAddress + output.rdOff, firstSize, first, diagnostics);
  if (!result.ok || first.size() != firstSize) {
    return result.ok ? invalid(ErrorCodes::kRttMemoryReadFailed, "RTT data read was short")
                     : memoryReadFailure(result, "RTT data read");
  }
  output.bytes = std::move(first);
  if (secondSize > 0) {
    std::vector<uint8_t> second;
    result = memory.read(output.bufferAddress, secondSize, second, diagnostics);
    if (!result.ok || second.size() != secondSize) {
      output.bytes.clear();
      return result.ok ? invalid(ErrorCodes::kRttMemoryReadFailed, "RTT wrapped data read was short")
                       : memoryReadFailure(result, "RTT wrapped data read");
    }
    output.bytes.insert(output.bytes.end(), second.begin(), second.end());
  }

  std::vector<uint8_t> afterDescriptor;
  result = memory.read(output.descriptorAddress, kBufferDescriptorSize, afterDescriptor, diagnostics);
  if (!result.ok || afterDescriptor.size() != kBufferDescriptorSize) {
    output.bytes.clear();
    return result.ok ? invalid(ErrorCodes::kRttMemoryReadFailed, "RTT descriptor confirmation was short")
                     : memoryReadFailure(result, "RTT descriptor confirmation");
  }
  const uint32_t afterWrOff = readLe32(afterDescriptor, 12);
  const uint32_t afterRdOff = readLe32(afterDescriptor, 16);
  const uint32_t afterFlags = readLe32(afterDescriptor, 20);
  output.writerAdvanced = afterWrOff != output.wrOff;
  if (afterRdOff != output.rdOff) {
    output.bytes.clear();
    output.overrun = true;
    return invalid(ErrorCodes::kRttBufferOverrun, "RTT RdOff changed while data was being read");
  }
  if (validateBufferFlags_) {
    const uint32_t afterMode = afterFlags & kRttModeMask;
    if ((afterFlags & ~kRttModeMask) != 0 || afterMode > kRttModeBlockIfFifoFull) {
      output.bytes.clear();
      output.flags = afterFlags;
      output.mode = afterMode;
      return invalid(ErrorCodes::kRttInvalidBufferFlags,
                     "RTT Up Buffer Flags became invalid while data was being read");
    }
    if (afterFlags != output.flags) {
      output.bytes.clear();
      return invalid(ErrorCodes::kRttInvalidBufferLayout,
                     "RTT Up Buffer Flags changed while data was being read"
                     " flagsBefore=" + std::to_string(output.flags)
                     + " flagsAfter=" + std::to_string(afterFlags));
    }
  }

  const uint32_t nextRdOff = (output.rdOff + static_cast<uint32_t>(output.bytes.size())) % output.bufferSize;
  result = memory.write(output.descriptorAddress + 16, le32(nextRdOff), diagnostics);
  if (!result.ok) {
    output.bytes.clear();
    return memoryWriteFailure(result);
  }
  output.readBytes = static_cast<uint32_t>(output.bytes.size());
  output.committedBytes = output.readBytes;
  output.committedRdOff = nextRdOff;
  return Result::success();
}

}  // namespace cmsis_dap_helper
