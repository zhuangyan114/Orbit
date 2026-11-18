#include "segger_rtt.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <string>
#include <thread>
#include <unordered_map>

namespace cmsis_dap_helper {
namespace {

constexpr uint32_t kDefaultSramBase = 0x20000000u;
constexpr uint32_t kDefaultSramSize = 0x20000u;
constexpr uint32_t kControlHeaderSize = 24u;
constexpr uint32_t kBufferDescriptorSize = 24u;
constexpr uint32_t kMaxRttBuffers = 64u;
constexpr uint32_t kMaxRttNameBytes = 64u;
constexpr size_t kMaxRttRamRanges = 32u;
constexpr uint32_t kMaxReadBytes = 65536u;
constexpr uint32_t kRttModeMask = 0x03u;
constexpr uint32_t kRttModeBlockIfFifoFull = 0x02u;
constexpr char kMagic[] = "SEGGER RTT";

const RttMemoryRange* findContainingRange(uint64_t address, uint64_t size,
                                          const std::vector<RttMemoryRange>& ranges) {
  if (size == 0) return nullptr;
  for (const RttMemoryRange& range : ranges) {
    const uint64_t base = static_cast<uint64_t>(range.address);
    const uint64_t capacity = static_cast<uint64_t>(range.size);
    if (address >= base && address - base <= capacity && size <= capacity - (address - base)) {
      return &range;
    }
  }
  return nullptr;
}

bool inRamRanges(uint64_t address, uint64_t size, const std::vector<RttMemoryRange>& ranges) {
  return findContainingRange(address, size, ranges) != nullptr;
}

bool rangesOverlap(uint32_t aAddress, uint32_t aSize, uint64_t bAddress, uint64_t bSize) {
  if (aSize == 0 || bSize == 0) return false;
  const uint64_t aStart = static_cast<uint64_t>(aAddress);
  const uint64_t aEnd = aStart + static_cast<uint64_t>(aSize);
  const uint64_t bEnd = bAddress + bSize;
  return aStart < bEnd && bAddress < aEnd;
}

const RttMemoryRange* findNameRange(uint32_t address,
                                    const std::vector<RttMemoryRange>& ramRanges,
                                    const std::vector<RttMemoryRange>& roRanges) {
  if (const RttMemoryRange* ram = findContainingRange(address, 1u, ramRanges)) return ram;
  return findContainingRange(address, 1u, roRanges);
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
  if (result.errorCode == ErrorCodes::kReadTimeout ||
      result.errorCode == ErrorCodes::kDeviceRemoved) {
    return result;
  }
  return Result::error(ErrorCodes::kRttMemoryReadFailed,
                       std::string(operation) + " failed: " + result.errorCode + ": " + result.message);
}

Result memoryWriteFailure(const Result& result) {
  if (result.errorCode == ErrorCodes::kWriteTimeout ||
      result.errorCode == ErrorCodes::kReadTimeout ||
      result.errorCode == ErrorCodes::kWriteCompletedLate ||
      result.errorCode == ErrorCodes::kOutcomeUnknown ||
      result.errorCode == ErrorCodes::kMalformedResponse ||
      result.errorCode == ErrorCodes::kDeviceRemoved) {
    return result;
  }
  return Result::error(ErrorCodes::kRttMemoryWriteFailed,
                       "RTT RdOff write failed: " + result.errorCode + ": " + result.message);
}

bool isUnknownWriteOutcome(const std::string& errorCode) {
  return errorCode == ErrorCodes::kWriteTimeout ||
      errorCode == ErrorCodes::kReadTimeout ||
      errorCode == ErrorCodes::kWriteCompletedLate ||
      errorCode == ErrorCodes::kOutcomeUnknown ||
      errorCode == ErrorCodes::kMalformedResponse ||
      errorCode == ErrorCodes::kDeviceRemoved ||
      errorCode == ErrorCodes::kDapAckNoAck;
}

Result downWriteFailure(const Result& result, const char* operation) {
  if (result.errorCode == ErrorCodes::kWriteTimeout ||
      result.errorCode == ErrorCodes::kReadTimeout ||
      result.errorCode == ErrorCodes::kWriteCompletedLate ||
      result.errorCode == ErrorCodes::kOutcomeUnknown ||
      result.errorCode == ErrorCodes::kMalformedResponse ||
      result.errorCode == ErrorCodes::kDeviceRemoved ||
      result.errorCode == ErrorCodes::kDapAckNoAck ||
      result.errorCode == ErrorCodes::kDapAckWait ||
      result.errorCode == ErrorCodes::kDapAckFault) {
    return result;
  }
  return Result::error(ErrorCodes::kRttMemoryWriteFailed,
                       std::string(operation) + " failed: " + result.errorCode + ": " + result.message);
}

void defaultRttSleep(std::chrono::milliseconds duration) {
  std::this_thread::sleep_for(duration);
}

struct CachedNameResult {
  std::string name;
  RttNameStatus status = RttNameStatus::None;
  std::string error;
};

CachedNameResult readChannelName(RttMemory& memory, uint32_t nameAddress,
                                 const std::vector<RttMemoryRange>& ramRanges,
                                 const std::vector<RttMemoryRange>& roRanges,
                                 std::unordered_map<uint32_t, CachedNameResult>& cache,
                                 DapTransferDiagnostics& diagnostics,
                                 Result& fatalError) {
  fatalError = Result::success();
  if (nameAddress == 0) {
    return {"", RttNameStatus::Null, ""};
  }
  const auto existing = cache.find(nameAddress);
  if (existing != cache.end()) {
    return existing->second;
  }

  CachedNameResult resolved;
  const RttMemoryRange* range = findNameRange(nameAddress, ramRanges, roRanges);
  if (!range) {
    resolved.status = RttNameStatus::InvalidAddress;
    resolved.error = "RTT buffer name address is outside valid RAM and RO ranges";
    cache.emplace(nameAddress, resolved);
    return resolved;
  }

  const uint64_t rangeEnd = static_cast<uint64_t>(range->address) + static_cast<uint64_t>(range->size);
  const uint32_t remaining = static_cast<uint32_t>(std::min<uint64_t>(kMaxRttNameBytes, rangeEnd - nameAddress));
  std::vector<uint8_t> bytes;
  const Result result = memory.read(nameAddress, remaining, bytes, diagnostics);
  if (!result.ok) {
    if (result.errorCode == ErrorCodes::kReadTimeout ||
        result.errorCode == ErrorCodes::kDeviceRemoved) {
      fatalError = result;
      return resolved;
    }
    resolved.status = RttNameStatus::ReadFailed;
    resolved.error = "RTT buffer name read failed: " + result.errorCode + ": " + result.message;
    cache.emplace(nameAddress, resolved);
    return resolved;
  }

  const auto nulIt = std::find(bytes.begin(), bytes.end(), static_cast<uint8_t>(0));
  if (nulIt != bytes.end()) {
    const size_t length = static_cast<size_t>(std::distance(bytes.begin(), nulIt));
    if (length == 0) {
      resolved.status = RttNameStatus::Empty;
    } else {
      resolved.status = RttNameStatus::Ok;
      resolved.name.assign(reinterpret_cast<const char*>(bytes.data()), length);
    }
    cache.emplace(nameAddress, resolved);
    return resolved;
  }

  if (bytes.size() < remaining) {
    resolved.status = RttNameStatus::ShortRead;
    resolved.error = "RTT buffer name read was short before NUL terminator (requested=" +
                     std::to_string(remaining) + " received=" + std::to_string(bytes.size()) + ")";
  } else {
    resolved.status = RttNameStatus::Unterminated;
    resolved.error = remaining < kMaxRttNameBytes
        ? "RTT buffer name reached memory region boundary without NUL terminator"
        : "RTT buffer name exceeded " + std::to_string(kMaxRttNameBytes) + " bytes without NUL terminator";
  }
  cache.emplace(nameAddress, resolved);
  return resolved;
}

void markDuplicateNames(std::vector<RttChannelDescriptor>& descriptors,
                        std::vector<std::string>& duplicateNames) {
  std::unordered_map<std::string, uint32_t> counts;
  for (const RttChannelDescriptor& entry : descriptors) {
    if (entry.valid && entry.nameStatus == RttNameStatus::Ok && !entry.name.empty()) {
      counts[entry.name] += 1u;
    }
  }
  for (RttChannelDescriptor& entry : descriptors) {
    if (entry.valid && entry.nameStatus == RttNameStatus::Ok && !entry.name.empty() &&
        counts[entry.name] > 1u) {
      entry.duplicateName = true;
      if (std::find(duplicateNames.begin(), duplicateNames.end(), entry.name) == duplicateNames.end()) {
        duplicateNames.push_back(entry.name);
      }
    }
  }
}

}  // namespace

const std::vector<RttMemoryRange>& SeggerRttReader::defaultSramRanges() {
  static const std::vector<RttMemoryRange> kDefault = {
    RttMemoryRange{kDefaultSramBase, kDefaultSramSize},
  };
  return kDefault;
}

Result SeggerRttReader::validateMemoryRanges(const std::vector<RttMemoryRange>& ranges,
                                             bool allowEmpty, const char* label) {
  if (ranges.empty()) {
    return allowEmpty
        ? Result::success()
        : invalid(ErrorCodes::kDapInvalidRequest, std::string(label) + " must not be empty");
  }
  if (ranges.size() > kMaxRttRamRanges) {
    return invalid(ErrorCodes::kDapInvalidRequest,
                   std::string(label) + " exceeds maximum of " + std::to_string(kMaxRttRamRanges) + " entries");
  }
  std::vector<RttMemoryRange> sorted = ranges;
  for (const RttMemoryRange& range : sorted) {
    if (range.size == 0) {
      return invalid(ErrorCodes::kDapInvalidRequest, std::string(label) + " entry size must be greater than zero");
    }
    if (static_cast<uint64_t>(range.address) + static_cast<uint64_t>(range.size) > 0x100000000ull) {
      return invalid(ErrorCodes::kDapInvalidRequest, std::string(label) + " entry overflows 32-bit address space");
    }
  }
  std::sort(sorted.begin(), sorted.end(), [](const RttMemoryRange& a, const RttMemoryRange& b) {
    return a.address < b.address;
  });
  for (size_t i = 1; i < sorted.size(); ++i) {
    const uint64_t prevEnd = static_cast<uint64_t>(sorted[i - 1].address) + sorted[i - 1].size;
    if (static_cast<uint64_t>(sorted[i].address) < prevEnd) {
      return invalid(ErrorCodes::kDapInvalidRequest, std::string(label) + " entries must not overlap");
    }
  }
  return Result::success();
}

Result SeggerRttReader::readControlBlock(RttMemory& memory, uint32_t controlBlockAddress,
                                         const std::vector<RttMemoryRange>& ramRanges,
                                         std::vector<uint8_t>& header,
                                         uint32_t& maxUpBuffers, uint32_t& maxDownBuffers,
                                         DapTransferDiagnostics& diagnostics) const {
  if (controlBlockAddress == 0 || (controlBlockAddress & 0x03u) != 0 ||
      !inRamRanges(controlBlockAddress, kControlHeaderSize, ramRanges)) {
    return invalid(ErrorCodes::kRttInvalidControlBlock,
                   "RTT Control Block address is outside valid target RAM ranges");
  }
  const Result result = memory.read(controlBlockAddress, kControlHeaderSize, header, diagnostics);
  if (!result.ok) return memoryReadFailure(result, "RTT Control Block read");
  if (header.size() != kControlHeaderSize || std::memcmp(header.data(), kMagic, sizeof(kMagic) - 1) != 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block magic is not SEGGER RTT");
  }
  maxUpBuffers = readLe32(header, 16);
  maxDownBuffers = readLe32(header, 20);
  if (maxUpBuffers == 0 || maxUpBuffers > kMaxRttBuffers || maxDownBuffers > kMaxRttBuffers) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block buffer counts are invalid");
  }
  const uint64_t descriptorsTotal = kControlHeaderSize
      + (static_cast<uint64_t>(maxUpBuffers) + maxDownBuffers) * kBufferDescriptorSize;
  if (!inRamRanges(controlBlockAddress, descriptorsTotal, ramRanges)) {
    return invalid(ErrorCodes::kRttInvalidControlBlock,
                   "RTT Control Block descriptors exceed valid target RAM ranges");
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
  if (!inRamRanges(address, kBufferDescriptorSize, ramRanges_)) {
    return invalid(ErrorCodes::kRttInvalidBufferLayout,
                   "RTT Up Buffer descriptor exceeds valid target RAM ranges");
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
      !inRamRanges(output.bufferAddress, output.bufferSize, ramRanges_) ||
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
  return start(memory, controlBlockAddress, defaultSramRanges(), diagnostics);
}

Result SeggerRttReader::start(RttMemory& memory, uint32_t controlBlockAddress,
                              const std::vector<RttMemoryRange>& ramRanges,
                              DapTransferDiagnostics& diagnostics) {
  const Result rangesValid = validateMemoryRanges(ramRanges, false, "ramRanges");
  if (!rangesValid.ok) return rangesValid;
  if (controlBlockAddress == 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block address is invalid");
  }
  std::vector<uint8_t> header;
  uint32_t maxUpBuffers = 0;
  uint32_t maxDownBuffers = 0;
  const Result result = readControlBlock(memory, controlBlockAddress, ramRanges, header,
                                         maxUpBuffers, maxDownBuffers, diagnostics);
  if (!result.ok) return result;
  controlBlockAddress_ = controlBlockAddress;
  ramRanges_ = ramRanges;
  started_ = true;
  return Result::success();
}

Result SeggerRttReader::stop() {
  started_ = false;
  controlBlockAddress_ = 0;
  ramRanges_.clear();
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
  uint32_t maxDownBuffers = 0;
  Result result = readControlBlock(memory, controlBlockAddress_, ramRanges_, header,
                                   maxUpBuffers, maxDownBuffers, diagnostics);
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

Result SeggerRttReader::enumerate(RttMemory& memory, uint32_t controlBlockAddress,
                                  const std::vector<RttMemoryRange>& ramRanges,
                                  const std::vector<RttMemoryRange>& roRanges,
                                  RttEnumerationResult& output,
                                  DapTransferDiagnostics& diagnostics,
                                  std::chrono::milliseconds timeout,
                                  std::optional<std::chrono::steady_clock::time_point> startTime,
                                  RttClockNow clockNow) const {
  output = RttEnumerationResult{};
  output.controlBlockAddress = controlBlockAddress;

  const Result ramValid = validateMemoryRanges(ramRanges, false, "ramRanges");
  if (!ramValid.ok) return ramValid;
  const Result roValid = validateMemoryRanges(roRanges, true, "roRanges");
  if (!roValid.ok) return roValid;
  if (controlBlockAddress == 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block address is invalid");
  }
  if (timeout.count() <= 0) {
    return invalid(ErrorCodes::kDapInvalidRequest, "RTT enumeration timeoutMs must be positive");
  }

  const RttClockNow nowFn = clockNow ? clockNow : &std::chrono::steady_clock::now;
  const auto started = startTime.value_or(nowFn());
  const auto deadline = started + timeout;
  auto deadlineReached = [&]() -> bool { return nowFn() >= deadline; };
  auto failTimeout = [&](const char* stage) -> Result {
    output = RttEnumerationResult{};
    output.controlBlockAddress = controlBlockAddress;
    return invalid(ErrorCodes::kReadTimeout,
                   std::string("RTT enumeration exceeded ") + std::to_string(timeout.count()) +
                       " ms deadline " + stage);
  };

  if (deadlineReached()) {
    return failTimeout("before control block header read");
  }

  std::vector<uint8_t> header;
  uint32_t maxUpBuffers = 0;
  uint32_t maxDownBuffers = 0;
  Result result = readControlBlock(memory, controlBlockAddress, ramRanges, header,
                                   maxUpBuffers, maxDownBuffers, diagnostics);
  if (!result.ok) return result;

  if (deadlineReached()) {
    return failTimeout("before descriptor table read");
  }

  output.maxUpBuffers = maxUpBuffers;
  output.maxDownBuffers = maxDownBuffers;

  const uint32_t totalBuffers = maxUpBuffers + maxDownBuffers;
  const uint32_t tableBytes = totalBuffers * kBufferDescriptorSize;
  std::vector<uint8_t> descriptors;
  result = memory.read(controlBlockAddress + kControlHeaderSize, tableBytes, descriptors, diagnostics);
  if (!result.ok) {
    output = RttEnumerationResult{};
    output.controlBlockAddress = controlBlockAddress;
    return memoryReadFailure(result, "RTT descriptor table read");
  }
  if (descriptors.size() != tableBytes) {
    output = RttEnumerationResult{};
    output.controlBlockAddress = controlBlockAddress;
    return invalid(ErrorCodes::kRttInvalidBufferLayout, "RTT descriptor table response is short");
  }

  std::unordered_map<uint32_t, CachedNameResult> nameCache;
  Result fatalStageError = Result::success();
  auto parseSlot = [&](RttChannelDirection direction, uint32_t index, size_t slotOrdinal,
                       RttChannelDescriptor& entry) -> bool {
    const size_t offset = slotOrdinal * kBufferDescriptorSize;
    entry = RttChannelDescriptor{};
    entry.direction = direction;
    entry.index = index;
    entry.descriptorAddress = controlBlockAddress + kControlHeaderSize + static_cast<uint32_t>(offset);
    entry.nameAddress = readLe32(descriptors, offset);
    entry.bufferAddress = readLe32(descriptors, offset + 4);
    entry.bufferSize = readLe32(descriptors, offset + 8);
    entry.wrOff = readLe32(descriptors, offset + 12);
    entry.rdOff = readLe32(descriptors, offset + 16);
    entry.flags = readLe32(descriptors, offset + 20);
    entry.mode = entry.flags & kRttModeMask;

    if (entry.nameAddress == 0 && entry.bufferAddress == 0 && entry.bufferSize == 0 &&
        entry.wrOff == 0 && entry.rdOff == 0 && entry.flags == 0) {
      entry.configured = false;
      entry.valid = false;
      entry.status = RttDescriptorStatus::Unused;
      entry.nameStatus = RttNameStatus::None;
      output.unusedCount += 1u;
      return true;
    }

    entry.configured = true;
    if (validateBufferFlags_ &&
        ((entry.flags & ~kRttModeMask) != 0 || entry.mode > kRttModeBlockIfFifoFull)) {
      entry.valid = false;
      entry.status = RttDescriptorStatus::Corrupt;
      entry.nameStatus = RttNameStatus::None;
      entry.errorCode = ErrorCodes::kRttInvalidBufferFlags;
      entry.errorMessage = "RTT buffer Flags contain an unknown mode or reserved bits";
      output.corruptCount += 1u;
      return true;
    }

    if (entry.bufferAddress == 0 || entry.bufferSize == 0 ||
        !inRamRanges(entry.bufferAddress, entry.bufferSize, ramRanges) ||
        entry.wrOff >= entry.bufferSize || entry.rdOff >= entry.bufferSize) {
      entry.valid = false;
      entry.status = RttDescriptorStatus::Corrupt;
      entry.nameStatus = RttNameStatus::None;
      entry.errorCode = ErrorCodes::kRttInvalidBufferLayout;
      entry.errorMessage = "RTT buffer pointer, size, or offsets are invalid or outside valid RAM ranges";
      output.corruptCount += 1u;
      return true;
    }

    entry.valid = true;
    entry.status = RttDescriptorStatus::Valid;
    if (direction == RttChannelDirection::Up) {
      output.validUpCount += 1u;
    } else {
      output.validDownCount += 1u;
    }

    if (entry.nameAddress != 0 && nameCache.find(entry.nameAddress) == nameCache.end() &&
        deadlineReached()) {
      fatalStageError = failTimeout("during channel name enumeration");
      return false;
    }

    const CachedNameResult name = readChannelName(
        memory, entry.nameAddress, ramRanges, roRanges, nameCache, diagnostics, fatalStageError);
    if (!fatalStageError.ok) {
      output = RttEnumerationResult{};
      output.controlBlockAddress = controlBlockAddress;
      return false;
    }
    entry.name = name.name;
    entry.nameStatus = name.status;
    entry.nameError = name.error;
    return true;
  };

  output.upBuffers.reserve(maxUpBuffers);
  for (uint32_t i = 0; i < maxUpBuffers; ++i) {
    RttChannelDescriptor entry;
    if (!parseSlot(RttChannelDirection::Up, i, i, entry)) return fatalStageError;
    output.upBuffers.push_back(std::move(entry));
  }
  output.downBuffers.reserve(maxDownBuffers);
  for (uint32_t j = 0; j < maxDownBuffers; ++j) {
    RttChannelDescriptor entry;
    if (!parseSlot(RttChannelDirection::Down, j, maxUpBuffers + j, entry)) return fatalStageError;
    output.downBuffers.push_back(std::move(entry));
  }

  if (deadlineReached()) {
    return failTimeout("after descriptor and name reads");
  }

  markDuplicateNames(output.upBuffers, output.duplicateUpNames);
  markDuplicateNames(output.downBuffers, output.duplicateDownNames);
  return Result::success();
}

Result SeggerRttReader::writeDown(RttMemory& memory, uint32_t controlBlockAddress,
                                  const std::vector<RttMemoryRange>& ramRanges,
                                  uint32_t bufferIndex, const std::vector<uint8_t>& bytes,
                                  RttWriteResult& output, DapTransferDiagnostics& diagnostics,
                                  std::chrono::milliseconds timeout,
                                  std::optional<std::chrono::steady_clock::time_point> startTime,
                                  RttClockNow clockNow, RttSleepFn sleepFn) const {
  output = RttWriteResult{};
  output.controlBlockAddress = controlBlockAddress;
  output.bufferIndex = bufferIndex;
  output.requestedBytes = static_cast<uint32_t>(bytes.size());
  output.completion = RttWriteCompletion::NotStarted;
  output.failureStage = RttWriteFailureStage::Validation;
  output.retryable = false;

  const Result ramValid = validateMemoryRanges(ramRanges, false, "ramRanges");
  if (!ramValid.ok) return ramValid;
  if (controlBlockAddress == 0) {
    return invalid(ErrorCodes::kRttInvalidControlBlock, "RTT Control Block address is invalid");
  }
  if (bytes.empty() || bytes.size() > kMaxReadBytes) {
    return invalid(ErrorCodes::kDapInvalidRequest, "RTT write size is outside 1..65536");
  }
  if (timeout.count() <= 0) {
    return invalid(ErrorCodes::kDapInvalidRequest, "RTT write timeoutMs must be positive");
  }

  const RttClockNow nowFn = clockNow ? clockNow : &std::chrono::steady_clock::now;
  const RttSleepFn sleep = sleepFn ? sleepFn : &defaultRttSleep;
  const auto started = startTime.value_or(nowFn());
  const auto deadline = started + timeout;
  auto deadlineReached = [&]() -> bool { return nowFn() >= deadline; };
  auto completionOnKnown = [&]() -> RttWriteCompletion {
    return output.committedBytes > 0 ? RttWriteCompletion::Partial : RttWriteCompletion::NotStarted;
  };
  auto failDeadline = [&](RttWriteFailureStage stage, const char* detail) -> Result {
    output.failureStage = stage;
    output.completion = completionOnKnown();
    output.shortWrite = output.committedBytes > 0 && output.committedBytes < output.requestedBytes;
    return Result::error(ErrorCodes::kWriteTimeout,
                         std::string("RTT Down write exceeded ") + std::to_string(timeout.count()) +
                             " ms deadline " + detail);
  };

  output.failureStage = RttWriteFailureStage::ControlBlock;
  if (deadlineReached()) {
    return failDeadline(RttWriteFailureStage::ControlBlock, "before control block read");
  }

  std::vector<uint8_t> header;
  uint32_t maxUpBuffers = 0;
  uint32_t maxDownBuffers = 0;
  Result result = readControlBlock(memory, controlBlockAddress, ramRanges, header,
                                   maxUpBuffers, maxDownBuffers, diagnostics);
  if (!result.ok) {
    output.completion = RttWriteCompletion::NotStarted;
    return result;
  }

  output.failureStage = RttWriteFailureStage::Descriptor;
  if (bufferIndex >= maxDownBuffers) {
    return invalid(ErrorCodes::kRttInvalidBufferIndex, "RTT Down Buffer index is out of range");
  }
  const uint64_t cbTotalBytes = static_cast<uint64_t>(kControlHeaderSize) +
      (static_cast<uint64_t>(maxUpBuffers) + static_cast<uint64_t>(maxDownBuffers)) * kBufferDescriptorSize;
  const uint64_t descAddress = static_cast<uint64_t>(controlBlockAddress) + kControlHeaderSize +
      (static_cast<uint64_t>(maxUpBuffers) + bufferIndex) * kBufferDescriptorSize;
  if (!inRamRanges(descAddress, kBufferDescriptorSize, ramRanges)) {
    return invalid(ErrorCodes::kRttInvalidBufferLayout,
                   "RTT Down Buffer descriptor exceeds valid target RAM ranges");
  }
  output.descriptorAddress = static_cast<uint32_t>(descAddress);

  auto readAndValidateDescriptor = [&](bool initial, uint32_t expectedWrOff,
                                       RttWriteFailureStage stage) -> Result {
    output.failureStage = stage;
    if (deadlineReached()) {
      return failDeadline(stage, "before descriptor read");
    }
    std::vector<uint8_t> descriptor;
    const Result descRead = memory.read(output.descriptorAddress, kBufferDescriptorSize, descriptor, diagnostics);
    if (!descRead.ok) {
      output.completion = completionOnKnown();
      return memoryReadFailure(descRead, "RTT Down Buffer descriptor read");
    }
    if (descriptor.size() != kBufferDescriptorSize) {
      output.completion = completionOnKnown();
      return invalid(ErrorCodes::kRttInvalidBufferLayout, "RTT Down Buffer descriptor response is short");
    }
    const uint32_t bufAddr = readLe32(descriptor, 4);
    const uint32_t bufSize = readLe32(descriptor, 8);
    const uint32_t wrOff = readLe32(descriptor, 12);
    const uint32_t rdOff = readLe32(descriptor, 16);
    const uint32_t flags = readLe32(descriptor, 20);
    const uint32_t mode = flags & kRttModeMask;

    if (initial) {
      output.bufferAddress = bufAddr;
      output.bufferSize = bufSize;
      output.initialWrOff = wrOff;
      output.initialRdOff = rdOff;
      output.rdOff = rdOff;
      output.committedWrOff = wrOff;
      output.flags = flags;
      output.mode = mode;
    }

    if (validateBufferFlags_ &&
        ((flags & ~kRttModeMask) != 0 || mode > kRttModeBlockIfFifoFull)) {
      output.completion = completionOnKnown();
      return invalid(ErrorCodes::kRttInvalidBufferFlags,
                     "RTT Down Buffer Flags contain an unknown mode or reserved bits"
                     " flags=" + std::to_string(flags) +
                         " mode=" + std::to_string(mode) +
                         " bufferIndex=" + std::to_string(bufferIndex));
    }
    if (bufAddr == 0 || bufSize == 0 ||
        !inRamRanges(bufAddr, bufSize, ramRanges) ||
        wrOff >= bufSize || rdOff >= bufSize) {
      output.completion = completionOnKnown();
      return invalid(ErrorCodes::kRttInvalidBufferLayout,
                     "RTT Down Buffer pointer, size, or offsets are invalid"
                     " address=" + std::to_string(bufAddr) +
                         " size=" + std::to_string(bufSize) +
                         " wrOff=" + std::to_string(wrOff) +
                         " rdOff=" + std::to_string(rdOff));
    }
    if (rangesOverlap(bufAddr, bufSize, static_cast<uint64_t>(controlBlockAddress), cbTotalBytes)) {
      output.completion = completionOnKnown();
      return invalid(ErrorCodes::kRttInvalidBufferLayout,
                     "RTT Down Buffer range overlaps RTT Control Block"
                     " address=" + std::to_string(bufAddr) +
                         " size=" + std::to_string(bufSize) +
                         " controlBlockAddress=" + std::to_string(controlBlockAddress) +
                         " controlBlockBytes=" + std::to_string(cbTotalBytes));
    }

    if (!initial) {
      if (bufAddr != output.bufferAddress || bufSize != output.bufferSize) {
        output.completion = completionOnKnown();
        return invalid(ErrorCodes::kRttInvalidBufferLayout,
                       "RTT Down Buffer layout changed while waiting for space");
      }
      if (validateBufferFlags_ && flags != output.flags) {
        output.completion = completionOnKnown();
        return invalid(ErrorCodes::kRttInvalidBufferFlags,
                       "RTT Down Buffer Flags changed while waiting for space");
      }
      if (wrOff != expectedWrOff) {
        output.completion = completionOnKnown();
        return invalid(ErrorCodes::kRttBufferOverrun,
                       "RTT Down Buffer WrOff changed concurrently while waiting for space");
      }
      output.rdOff = rdOff;
    }
    return Result::success();
  };

  result = readAndValidateDescriptor(true, 0u, RttWriteFailureStage::Descriptor);
  if (!result.ok) return result;

  uint32_t currentWrOff = output.initialWrOff;
  uint32_t offset = 0;
  const uint32_t totalBytes = static_cast<uint32_t>(bytes.size());

  while (offset < totalBytes) {
    if (offset > 0) {
      result = readAndValidateDescriptor(false, currentWrOff, RttWriteFailureStage::PollWait);
      if (!result.ok) return result;
    }

    const uint32_t avail = output.rdOff <= currentWrOff
        ? (output.bufferSize - 1u - currentWrOff + output.rdOff)
        : (output.rdOff - currentWrOff - 1u);
    output.availableSpace = avail;

    uint32_t chunkSize = 0;
    if (output.mode == 0u) {
      if (avail < totalBytes) {
        output.shortWrite = true;
        output.skipped = true;
        output.completion = RttWriteCompletion::NotStarted;
        output.failureStage = RttWriteFailureStage::None;
        return Result::success();
      }
      chunkSize = totalBytes;
    } else if (output.mode == 1u) {
      chunkSize = std::min(avail, totalBytes);
      if (chunkSize < totalBytes) {
        output.shortWrite = true;
      }
      if (chunkSize == 0u) {
        output.completion = RttWriteCompletion::NotStarted;
        output.failureStage = RttWriteFailureStage::None;
        return Result::success();
      }
    } else {
      // Mode 2: SEGGER_RTT_MODE_BLOCK_IF_FIFO_FULL
      if (avail == 0u) {
        if (deadlineReached()) {
          return failDeadline(RttWriteFailureStage::PollWait, "while waiting for Down buffer space");
        }
        const auto rem = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - nowFn());
        const auto waitMs = std::max(std::chrono::milliseconds(1),
                                     std::min(std::chrono::milliseconds(1), rem));
        sleep(waitMs);
        if (deadlineReached()) {
          return failDeadline(RttWriteFailureStage::PollWait, "after wait for Down buffer space");
        }
        result = readAndValidateDescriptor(false, currentWrOff, RttWriteFailureStage::PollWait);
        if (!result.ok) return result;
        continue;
      }
      chunkSize = std::min(avail, totalBytes - offset);
    }

    output.firstSegmentWritten = false;
    output.secondSegmentWritten = false;
    output.wrOffWriteAttempted = false;
    output.wrOffCommitted = false;

    const uint32_t tail = output.bufferSize - currentWrOff;
    const uint32_t firstSize = std::min(chunkSize, tail);
    const uint32_t secondSize = chunkSize - firstSize;
    if (secondSize > 0u) {
      output.wrapped = true;
    }

    // Commit order invariant: write valid ring data BEFORE publishing WrOff;
    // never touch target-owned RdOff. Never blindly retry a failed write.
    output.failureStage = RttWriteFailureStage::DataFirst;
    if (deadlineReached()) {
      return failDeadline(RttWriteFailureStage::DataFirst, "before data segment 1 write");
    }
    std::vector<uint8_t> first(bytes.begin() + offset, bytes.begin() + offset + firstSize);
    Result writeRes = memory.write(output.bufferAddress + currentWrOff, first, diagnostics);
    if (!writeRes.ok) {
      const Result mapped = downWriteFailure(writeRes, "RTT Down data segment 1 write");
      output.completion = isUnknownWriteOutcome(mapped.errorCode)
          ? RttWriteCompletion::Unknown
          : completionOnKnown();
      output.shortWrite = output.committedBytes > 0 && output.committedBytes < totalBytes;
      return mapped;
    }
    output.firstSegmentWritten = true;
    output.writtenBytes += firstSize;

    if (secondSize > 0u) {
      output.failureStage = RttWriteFailureStage::DataSecond;
      if (deadlineReached()) {
        return failDeadline(RttWriteFailureStage::DataSecond, "before data segment 2 write");
      }
      std::vector<uint8_t> second(bytes.begin() + offset + firstSize,
                                  bytes.begin() + offset + chunkSize);
      writeRes = memory.write(output.bufferAddress, second, diagnostics);
      if (!writeRes.ok) {
        const Result mapped = downWriteFailure(writeRes, "RTT Down data segment 2 write");
        output.completion = isUnknownWriteOutcome(mapped.errorCode)
            ? RttWriteCompletion::Unknown
            : completionOnKnown();
        output.shortWrite = output.committedBytes > 0 && output.committedBytes < totalBytes;
        return mapped;
      }
      output.secondSegmentWritten = true;
      output.writtenBytes += secondSize;
    }

    output.failureStage = RttWriteFailureStage::CommitWrOff;
    if (deadlineReached()) {
      return failDeadline(RttWriteFailureStage::CommitWrOff, "before WrOff commit");
    }
    const uint32_t nextWrOff = (currentWrOff + chunkSize) % output.bufferSize;
    output.wrOffWriteAttempted = true;
    writeRes = memory.write(output.descriptorAddress + 12u, le32(nextWrOff), diagnostics);
    if (!writeRes.ok) {
      const Result mapped = downWriteFailure(writeRes, "RTT Down WrOff commit");
      output.completion = isUnknownWriteOutcome(mapped.errorCode)
          ? RttWriteCompletion::Unknown
          : completionOnKnown();
      output.shortWrite = output.committedBytes > 0 && output.committedBytes < totalBytes;
      return mapped;
    }

    output.wrOffCommitted = true;
    currentWrOff = nextWrOff;
    output.committedWrOff = nextWrOff;
    output.committedBytes += chunkSize;
    offset += chunkSize;

    if (output.mode != kRttModeBlockIfFifoFull) {
      break;
    }
  }

  output.failureStage = RttWriteFailureStage::None;
  output.completion = (output.committedBytes == totalBytes)
      ? RttWriteCompletion::Completed
      : RttWriteCompletion::Partial;
  return Result::success();
}

}  // namespace cmsis_dap_helper
