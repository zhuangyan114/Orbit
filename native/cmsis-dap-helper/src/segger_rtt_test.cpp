#include "segger_rtt.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace {

using cmsis_dap_helper::DapTransferDiagnostics;
using cmsis_dap_helper::Result;
using cmsis_dap_helper::RttChannelDescriptor;
using cmsis_dap_helper::RttChannelDirection;
using cmsis_dap_helper::RttDescriptorStatus;
using cmsis_dap_helper::RttEnumerationResult;
using cmsis_dap_helper::RttMemory;
using cmsis_dap_helper::RttMemoryRange;
using cmsis_dap_helper::RttNameStatus;
using cmsis_dap_helper::RttReadResult;
using cmsis_dap_helper::RttWriteCompletion;
using cmsis_dap_helper::RttWriteFailureStage;
using cmsis_dap_helper::RttWriteResult;
using cmsis_dap_helper::SeggerRttReader;

constexpr uint32_t kSramBase = 0x20000000u;
constexpr uint32_t kSramSize = 0x20000u;
constexpr uint32_t kControl = 0x20000100u;
constexpr uint32_t kBuffer = 0x20001000u;
constexpr uint32_t kBufferSize = 8u;

class FakeMemory final : public RttMemory {
 public:
  std::vector<uint8_t> bytes = std::vector<uint8_t>(kSramSize, 0);
  bool failRead = false;
  bool failWrite = false;
  bool advanceWriterOnDataRead = false;
  bool changeFlagsOnDataRead = false;
  uint32_t writeCount = 0;
  uint32_t readCount = 0;

  Result read(uint32_t address, uint32_t size, std::vector<uint8_t>& output,
              DapTransferDiagnostics&) override {
    ++readCount;
    if (failRead) return Result::error("RttMemoryReadFailed", "oracle read failure");
    if (address < kSramBase || size > kSramSize || address - kSramBase > kSramSize - size) {
      return Result::error("RttMemoryReadFailed", "oracle read out of range");
    }
    output.assign(bytes.begin() + (address - kSramBase),
                  bytes.begin() + (address - kSramBase + size));
    if (advanceWriterOnDataRead && address == kBuffer) {
      write32(kControl + 24 + 12, 5);
    }
    if (changeFlagsOnDataRead && address == kBuffer) {
      write32(kControl + 24 + 20, 3);
    }
    return Result::success();
  }

  Result write(uint32_t address, const std::vector<uint8_t>& input,
               DapTransferDiagnostics&) override {
    ++writeCount;
    if (failWrite) return Result::error("RttMemoryWriteFailed", "oracle write failure");
    if (address < kSramBase || input.size() > kSramSize ||
        address - kSramBase > kSramSize - input.size()) {
      return Result::error("RttMemoryWriteFailed", "oracle write out of range");
    }
    std::copy(input.begin(), input.end(), bytes.begin() + (address - kSramBase));
    return Result::success();
  }

  void write32(uint32_t address, uint32_t value) {
    for (uint32_t i = 0; i < 4; ++i) bytes[address - kSramBase + i] = static_cast<uint8_t>(value >> (i * 8));
  }

  uint32_t read32(uint32_t address) const {
    uint32_t value = 0;
    for (uint32_t i = 0; i < 4; ++i) value |= static_cast<uint32_t>(bytes[address - kSramBase + i]) << (i * 8);
    return value;
  }

  void reset(uint32_t wrOff = 3, uint32_t rdOff = 0, uint32_t flags = 0) {
    std::fill(bytes.begin(), bytes.end(), static_cast<uint8_t>(0));
    writeCount = 0;
    readCount = 0;
    failRead = false;
    failWrite = false;
    advanceWriterOnDataRead = false;
    changeFlagsOnDataRead = false;
    const char magic[] = "SEGGER RTT";
    std::copy(magic, magic + 10, bytes.begin() + (kControl - kSramBase));
    write32(kControl + 16, 1);
    write32(kControl + 20, 0);
    write32(kControl + 24 + 4, kBuffer);
    write32(kControl + 24 + 8, kBufferSize);
    write32(kControl + 24 + 12, wrOff);
    write32(kControl + 24 + 16, rdOff);
    write32(kControl + 24 + 20, flags);
  }
};

class MultiRegionMemory final : public RttMemory {
 public:
  struct Region {
    uint32_t address = 0;
    std::vector<uint8_t> data;
  };

  std::vector<Region> regions;
  std::map<uint32_t, uint32_t> shortReads;
  std::set<uint32_t> failReads;
  std::set<uint32_t> timeoutReads;
  std::vector<std::pair<uint32_t, uint32_t>> readLog;
  void (*onRead)() = nullptr;

  void addRegion(uint32_t address, uint32_t size) {
    regions.push_back(Region{address, std::vector<uint8_t>(size, 0)});
  }

  void writeBytes(uint32_t address, const std::vector<uint8_t>& input) {
    for (Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + input.size() <= end) {
        std::copy(input.begin(), input.end(), region.data.begin() + (address - region.address));
        return;
      }
    }
  }

  void write32(uint32_t address, uint32_t value) {
    writeBytes(address, {
        static_cast<uint8_t>(value & 0xFFu),
        static_cast<uint8_t>((value >> 8) & 0xFFu),
        static_cast<uint8_t>((value >> 16) & 0xFFu),
        static_cast<uint8_t>((value >> 24) & 0xFFu),
    });
  }

  uint32_t read32(uint32_t address) const {
    for (const Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + 4 <= end) {
        const size_t off = address - region.address;
        return static_cast<uint32_t>(region.data[off])
            | (static_cast<uint32_t>(region.data[off + 1]) << 8)
            | (static_cast<uint32_t>(region.data[off + 2]) << 16)
            | (static_cast<uint32_t>(region.data[off + 3]) << 24);
      }
    }
    return 0;
  }

  void writeCString(uint32_t address, const std::string& text) {
    std::vector<uint8_t> bytes(text.begin(), text.end());
    bytes.push_back(0);
    writeBytes(address, bytes);
  }

  void writeControlHeader(uint32_t address, uint32_t maxUp, uint32_t maxDown,
                          const char* magic = "SEGGER RTT") {
    std::vector<uint8_t> header(24, 0);
    std::copy(magic, magic + 10, header.begin());
    writeBytes(address, header);
    write32(address + 16, maxUp);
    write32(address + 20, maxDown);
  }

  void writeDescriptor(uint32_t address, uint32_t sName, uint32_t pBuffer, uint32_t size,
                       uint32_t wrOff, uint32_t rdOff, uint32_t flags) {
    write32(address, sName);
    write32(address + 4, pBuffer);
    write32(address + 8, size);
    write32(address + 12, wrOff);
    write32(address + 16, rdOff);
    write32(address + 20, flags);
  }

  Result read(uint32_t address, uint32_t size, std::vector<uint8_t>& output,
              DapTransferDiagnostics&) override {
    readLog.emplace_back(address, size);
    if (onRead) onRead();
    if (timeoutReads.count(address) != 0) {
      return Result::error("ReadTimeout", "injected read timeout");
    }
    if (failReads.count(address) != 0) {
      return Result::error("DapAckFault", "injected read fault");
    }
    uint32_t effectiveSize = size;
    const auto shortIt = shortReads.find(address);
    if (shortIt != shortReads.end() && shortIt->second < effectiveSize) {
      effectiveSize = shortIt->second;
    }
    for (const Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + effectiveSize <= end) {
        output.assign(region.data.begin() + (address - region.address),
                      region.data.begin() + (address - region.address + effectiveSize));
        return Result::success();
      }
    }
    return Result::error("RttMemoryReadFailed", "oracle multi-region read out of range");
  }

  Result write(uint32_t address, const std::vector<uint8_t>& input,
               DapTransferDiagnostics&) override {
    for (Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + input.size() <= end) {
        std::copy(input.begin(), input.end(), region.data.begin() + (address - region.address));
        return Result::success();
      }
    }
    return Result::error("RttMemoryWriteFailed", "oracle multi-region write out of range");
  }
};

void expect(bool condition, const char* name, int& failures) {
  if (!condition) {
    std::cerr << "FAIL " << name << '\n';
    ++failures;
  }
}

int runLegacyBaselineTests() {
  int failures = 0;
  FakeMemory memory;
  SeggerRttReader reader;
  DapTransferDiagnostics diagnostics;
  RttReadResult output;

  memory.reset();
  expect(reader.start(memory, kControl, diagnostics).ok, "valid-control-block", failures);
  memory.bytes[kBuffer - kSramBase] = 'a';
  memory.bytes[kBuffer - kSramBase + 1] = 'b';
  memory.bytes[kBuffer - kSramBase + 2] = 'c';
  expect(reader.read(memory, 0, 8, output, diagnostics).ok &&
             std::string(output.bytes.begin(), output.bytes.end()) == "abc" &&
             output.flags == 0 && output.mode == 0 &&
             memory.read32(kControl + 24 + 16) == 3,
         "linear-read-commits-rdoff", failures);

  const uint32_t writesBeforeEmpty = memory.writeCount;
  expect(reader.read(memory, 0, 8, output, diagnostics).ok && output.bytes.empty() &&
             memory.writeCount == writesBeforeEmpty,
         "empty-read-does-not-write", failures);

  memory.reset(2, 6);
  for (uint32_t i = 0; i < kBufferSize; ++i) memory.bytes[kBuffer - kSramBase + i] = static_cast<uint8_t>('A' + i);
  expect(reader.read(memory, 0, 8, output, diagnostics).ok &&
             std::string(output.bytes.begin(), output.bytes.end()) == "GHAB" &&
             output.flags == 0 && output.mode == 0 &&
             memory.read32(kControl + 24 + 16) == 2,
         "wrap-read-commits-rdoff", failures);

  memory.reset(3, 0, 1);
  memory.bytes[kBuffer - kSramBase] = 'a';
  memory.bytes[kBuffer - kSramBase + 1] = 'b';
  memory.bytes[kBuffer - kSramBase + 2] = 'c';
  expect(reader.read(memory, 0, 8, output, diagnostics).ok &&
             std::string(output.bytes.begin(), output.bytes.end()) == "abc" &&
             output.flags == 1 && output.mode == 1,
         "flags-mode-1-linear-read", failures);

  memory.reset(2, 6, 2);
  for (uint32_t i = 0; i < kBufferSize; ++i) memory.bytes[kBuffer - kSramBase + i] = static_cast<uint8_t>('A' + i);
  expect(reader.read(memory, 0, 8, output, diagnostics).ok &&
             std::string(output.bytes.begin(), output.bytes.end()) == "GHAB" &&
             output.flags == 2 && output.mode == 2,
         "flags-mode-2-wrapped-read", failures);

  for (const uint32_t flags : {3u, 4u, 0x80000000u}) {
    memory.reset(3, 0, flags);
    const uint32_t writesBeforeInvalidFlags = memory.writeCount;
    const Result invalidFlags = reader.read(memory, 0, 8, output, diagnostics);
    expect(!invalidFlags.ok && invalidFlags.errorCode == "RttInvalidBufferFlags" &&
               output.bytes.empty() && memory.writeCount == writesBeforeInvalidFlags &&
               memory.read32(kControl + 24 + 16) == 0,
           flags == 3 ? "flags-mode-3-rejected"
                      : flags == 4 ? "flags-reserved-bit-rejected"
                                   : "flags-high-bit-rejected",
           failures);
  }

  memory.reset(3, 0);
  memory.bytes[kControl - kSramBase] = 'X';
  expect(!reader.start(memory, kControl, diagnostics).ok, "invalid-magic", failures);

  memory.reset();
  memory.write32(kControl + 24 + 4, 0);
  expect(reader.start(memory, kControl, diagnostics).ok &&
             !reader.read(memory, 0, 8, output, diagnostics).ok &&
             output.bytes.empty(),
         "invalid-buffer-pointer", failures);

  memory.reset();
  expect(reader.start(memory, kControl, diagnostics).ok, "restart-after-invalid", failures);
  memory.failRead = true;
  const uint32_t rdBeforeReadFailure = memory.read32(kControl + 24 + 16);
  expect(!reader.read(memory, 0, 8, output, diagnostics).ok && output.bytes.empty() &&
             memory.read32(kControl + 24 + 16) == rdBeforeReadFailure,
         "read-failure-does-not-commit", failures);

  memory.failRead = false;
  memory.failWrite = true;
  expect(!reader.read(memory, 0, 8, output, diagnostics).ok && output.bytes.empty() &&
             memory.read32(kControl + 24 + 16) == rdBeforeReadFailure,
         "write-failure-does-not-publish", failures);

  memory.failWrite = false;
  memory.reset(3, 0, 1);
  memory.changeFlagsOnDataRead = true;
  const Result changedFlags = reader.read(memory, 0, 2, output, diagnostics);
  expect(!changedFlags.ok && output.bytes.empty() &&
             memory.read32(kControl + 24 + 16) == 0,
         "flags-change-during-confirmation-does-not-commit", failures);

  memory.reset(7, 0);
  expect(reader.start(memory, kControl, diagnostics).ok && reader.read(memory, 0, 2, output, diagnostics).ok &&
             output.bytes.size() == 2 && memory.read32(kControl + 24 + 16) == 2,
         "read-size-bound", failures);

  memory.reset(3, 0);
  memory.advanceWriterOnDataRead = true;
  expect(reader.start(memory, kControl, diagnostics).ok &&
             reader.read(memory, 0, 2, output, diagnostics).ok &&
             output.writerAdvanced && output.bytes.size() == 2 &&
             memory.read32(kControl + 24 + 16) == 2,
         "writer-advanced-read-commits-confirmed-bytes", failures);

  expect(!reader.read(memory, 1, 2, output, diagnostics).ok, "buffer-index-bounds", failures);
  return failures;
}

int runRangeAndEnumerationTests() {
  int failures = 0;
  DapTransferDiagnostics diagnostics;

  // 1. RAM range input validation (empty, zero size, overflow, overlap, >32 entries, ITCM base 0)
  {
    MultiRegionMemory mem;
    SeggerRttReader reader;
    RttEnumerationResult enumOut;
    expect(!reader.start(mem, 0x24000100u, {}, diagnostics).ok, "rejects-empty-ram-ranges", failures);
    expect(!reader.start(mem, 0x24000100u, {{0x24000000u, 0u}}, diagnostics).ok,
           "rejects-zero-size-ram-range", failures);
    expect(!reader.start(mem, 0xFFFF0000u, {{0xFFFF0000u, 0x20000u}}, diagnostics).ok,
           "rejects-overflowing-ram-range", failures);
    expect(!reader.start(mem, 0x20000100u,
                         {{0x20000000u, 0x2000u}, {0x20001000u, 0x2000u}}, diagnostics).ok,
           "rejects-overlapping-ram-ranges", failures);
    std::vector<RttMemoryRange> tooMany(33, RttMemoryRange{0x20000000u, 0x100u});
    for (size_t i = 0; i < tooMany.size(); ++i) {
      tooMany[i].address = 0x20000000u + static_cast<uint32_t>(i) * 0x100u;
    }
    expect(!reader.start(mem, 0x20000000u, tooMany, diagnostics).ok,
           "rejects-more-than-32-ram-ranges", failures);
    // ITCM region starting at address 0 is valid as a RAM range, while NULL CB=0 is still rejected.
    const std::vector<RttMemoryRange> h7ItcmAndAxi = {
        {0x00000000u, 0x10000u},
        {0x24000000u, 0x50000u},
    };
    const Result nullCb = reader.enumerate(mem, 0u, h7ItcmAndAxi, {}, enumOut, diagnostics);
    expect(!nullCb.ok && nullCb.errorCode == "RttInvalidControlBlock",
           "itcm-range-valid-but-null-cb-rejected", failures);
  }

  // 2. Non-fixed RAM range (e.g. H723 AXI SRAM 0x24000000 + DTCM 0x20000000 + Flash RO 0x08000000)
  //    CB in DTCM, buffer in AXI SRAM, sName in Flash RO and in RAM.
  {
    MultiRegionMemory mem;
    mem.addRegion(0x00000000u, 0x10000u);  // ITCM
    mem.addRegion(0x08000000u, 0x20000u);  // Flash
    mem.addRegion(0x20000000u, 0x1000u);   // RAM region A
    mem.addRegion(0x20001000u, 0x1000u);   // RAM region B (adjacent to A, separate region)
    mem.addRegion(0x24000000u, 0x50000u);  // AXI SRAM

    const std::vector<RttMemoryRange> ramRanges = {
        {0x00000000u, 0x10000u},
        {0x20000000u, 0x1000u},
        {0x20001000u, 0x1000u},
        {0x24000000u, 0x50000u},
    };
    const std::vector<RttMemoryRange> roRanges = {{0x08000000u, 0x20000u}};

    const uint32_t cb = 0x24000100u;
    const uint32_t up0Buf = 0x24001000u;
    const uint32_t up2Buf = 0x20000200u;  // Cross-RAM-region buffer relative to CB (still valid!)
    const uint32_t down0Buf = 0x24002000u;
    const uint32_t down1Buf = 0x24002400u;
    const uint32_t flashTerminalName = 0x08001000u;
    const uint32_t ramSysViewName = 0x24003000u;

    mem.writeCString(flashTerminalName, "Terminal");
    mem.writeCString(ramSysViewName, "SysView");
    mem.writeControlHeader(cb, 3, 2);
    // Up[0]: "Terminal" in Flash, buffer in AXI SRAM
    mem.writeDescriptor(cb + 24 * 1, flashTerminalName, up0Buf, 64, 4, 0, 0);
    // Up[1]: unused (all zeros)
    mem.writeDescriptor(cb + 24 * 2, 0, 0, 0, 0, 0, 0);
    // Up[2]: "SysView" in RAM, buffer in DTCM region A
    mem.writeDescriptor(cb + 24 * 3, ramSysViewName, up2Buf, 128, 3, 0, 1);
    // Down[0]: "Terminal" in Flash (same name as Up[0], different direction -> NOT duplicate)
    mem.writeDescriptor(cb + 24 * 4, flashTerminalName, down0Buf, 32, 0, 0, 0);
    // Down[1]: "SysView" in RAM
    mem.writeDescriptor(cb + 24 * 5, ramSysViewName, down1Buf, 64, 0, 0, 2);
    mem.writeBytes(up2Buf, {'X', 'Y', 'Z'});

    SeggerRttReader reader;
    RttEnumerationResult enumOut;
    const Result enumRes = reader.enumerate(mem, cb, ramRanges, roRanges, enumOut, diagnostics);
    expect(enumRes.ok &&
               enumOut.controlBlockAddress == cb &&
               enumOut.maxUpBuffers == 3 &&
               enumOut.maxDownBuffers == 2 &&
               enumOut.validUpCount == 2 &&
               enumOut.validDownCount == 2 &&
               enumOut.unusedCount == 1 &&
               enumOut.corruptCount == 0 &&
               enumOut.duplicateUpNames.empty() &&
               enumOut.duplicateDownNames.empty() &&
               enumOut.upBuffers.size() == 3 &&
               enumOut.downBuffers.size() == 2 &&
               enumOut.upBuffers[0].valid && enumOut.upBuffers[0].name == "Terminal" &&
               enumOut.upBuffers[0].nameStatus == RttNameStatus::Ok &&
               !enumOut.upBuffers[0].duplicateName &&
               enumOut.upBuffers[1].status == RttDescriptorStatus::Unused &&
               !enumOut.upBuffers[1].configured && !enumOut.upBuffers[1].valid &&
               enumOut.upBuffers[1].nameStatus == RttNameStatus::None &&
               enumOut.upBuffers[2].valid && enumOut.upBuffers[2].name == "SysView" &&
               enumOut.upBuffers[2].bufferAddress == up2Buf &&
               !enumOut.upBuffers[2].duplicateName &&
               enumOut.downBuffers[0].direction == RttChannelDirection::Down &&
               enumOut.downBuffers[0].valid && enumOut.downBuffers[0].name == "Terminal" &&
               !enumOut.downBuffers[0].duplicateName &&
               enumOut.downBuffers[1].valid && enumOut.downBuffers[1].name == "SysView" &&
               enumOut.downBuffers[1].mode == 2 && !enumOut.downBuffers[1].duplicateName,
           "non-fixed-ram-and-up-down-enumeration", failures);

    // start + read on non-fixed AXI SRAM CB and cross-region DTCM buffer
    RttReadResult readOut;
    expect(reader.start(mem, cb, ramRanges, diagnostics).ok &&
               reader.read(mem, 2, 16, readOut, diagnostics).ok &&
               std::string(readOut.bytes.begin(), readOut.bytes.end()) == "XYZ" &&
               mem.read32(cb + 24 * 3 + 16) == 3,
           "non-fixed-ram-start-and-read", failures);
    reader.stop();

    // Cross-region control block + descriptors (starts near end of region A 0x20000FC0 and spans into region B)
    const uint32_t crossCb = 0x20000FC0u;  // 24 + (2+1)*24 = 96 bytes -> 0x20000FC0..0x20001020
    mem.writeControlHeader(crossCb, 2, 1);
    const Result crossCbStart = reader.start(mem, crossCb, ramRanges, diagnostics);
    const Result crossCbEnum = reader.enumerate(mem, crossCb, ramRanges, roRanges, enumOut, diagnostics);
    expect(!crossCbStart.ok && crossCbStart.errorCode == "RttInvalidControlBlock" &&
               !crossCbEnum.ok && crossCbEnum.errorCode == "RttInvalidControlBlock",
           "cross-region-control-block-rejected", failures);

    // Cross-region ring buffer (0x20000FF8 size 16 spans region A -> region B)
    const uint32_t okCb = 0x20000100u;
    mem.writeControlHeader(okCb, 1, 0);
    mem.writeDescriptor(okCb + 24, 0, 0x20000FF8u, 16, 4, 0, 0);
    expect(reader.start(mem, okCb, ramRanges, diagnostics).ok, "cb-in-region-a-starts", failures);
    const Result crossBufRead = reader.read(mem, 0, 8, readOut, diagnostics);
    const Result crossBufEnum = reader.enumerate(mem, okCb, ramRanges, roRanges, enumOut, diagnostics);
    expect(!crossBufRead.ok && crossBufRead.errorCode == "RttInvalidBufferLayout" &&
               crossBufEnum.ok && enumOut.corruptCount == 1 &&
               enumOut.upBuffers[0].status == RttDescriptorStatus::Corrupt &&
               enumOut.upBuffers[0].errorCode == "RttInvalidBufferLayout",
           "cross-region-ring-buffer-rejected", failures);
    reader.stop();

    // Out-of-bounds CB (in 0x20010000 which is outside ramRanges, even though inside legacy F407 128K!)
    const Result oobCb = reader.start(mem, 0x20010000u, ramRanges, diagnostics);
    expect(!oobCb.ok && oobCb.errorCode == "RttInvalidControlBlock",
           "out-of-bounds-cb-rejected-despite-legacy-sram", failures);
  }

  // 3. Empty name, duplicate name, short name read, unterminated, invalid address, read failed, corrupt descriptors
  {
    MultiRegionMemory mem;
    mem.addRegion(0x24000000u, 0x10000u);
    mem.addRegion(0x08000000u, 0x4000u);
    const std::vector<RttMemoryRange> ramRanges = {{0x24000000u, 0x10000u}};
    const std::vector<RttMemoryRange> roRanges = {{0x08000000u, 0x4000u}};

    const uint32_t cb = 0x24000100u;
    mem.writeControlHeader(cb, 9, 3);

    const uint32_t nameEmptyStr = 0x24000800u;
    const uint32_t nameSysView = 0x24000810u;
    const uint32_t nameShort = 0x24000820u;
    const uint32_t nameShortWithNul = 0x24000840u;
    const uint32_t nameAtBoundary = 0x2400FFFBu;  // 5 bytes from end, no NUL
    const uint32_t nameTooLong = 0x24000900u;     // 64 'A's, no NUL
    const uint32_t nameReadFail = 0x24000980u;
    const uint32_t nameInvalidAddr = 0x40020000u; // peripheral space, must NOT be read

    mem.writeCString(nameEmptyStr, "");
    mem.writeCString(nameSysView, "SysView");
    mem.writeBytes(nameShort, {'S', 'y', 's', 'V', 'i', 'e', 'w', 0});
    mem.shortReads[nameShort] = 4;  // returns "SysV" without NUL!
    mem.writeCString(nameShortWithNul, "OK");
    mem.shortReads[nameShortWithNul] = 6;  // short read vs 64, but includes NUL
    mem.writeBytes(nameAtBoundary, {'T', 'R', 'U', 'N', 'C'});  // no NUL up to region end
    mem.writeBytes(nameTooLong, std::vector<uint8_t>(64, 'A'));
    mem.failReads.insert(nameReadFail);

    // Up[0]: null sName
    mem.writeDescriptor(cb + 24 * 1, 0, 0x24001000u, 64, 0, 0, 0);
    // Up[1]: "" empty C string
    mem.writeDescriptor(cb + 24 * 2, nameEmptyStr, 0x24001100u, 64, 0, 0, 0);
    // Up[2]: "SysView" (duplicate 1)
    mem.writeDescriptor(cb + 24 * 3, nameSysView, 0x24001200u, 64, 0, 0, 0);
    // Up[3]: "SysView" (duplicate 2)
    mem.writeDescriptor(cb + 24 * 4, nameSysView, 0x24001300u, 64, 0, 0, 0);
    // Up[4]: short name read (no NUL)
    mem.writeDescriptor(cb + 24 * 5, nameShort, 0x24001400u, 64, 0, 0, 0);
    // Up[5]: short read that already contains NUL ("OK")
    mem.writeDescriptor(cb + 24 * 6, nameShortWithNul, 0x24001500u, 64, 0, 0, 0);
    // Up[6]: unterminated at region boundary
    mem.writeDescriptor(cb + 24 * 7, nameAtBoundary, 0x24001600u, 64, 0, 0, 0);
    // Up[7]: invalid sName address (peripheral)
    mem.writeDescriptor(cb + 24 * 8, nameInvalidAddr, 0x24001700u, 64, 0, 0, 0);
    // Up[8]: corrupt descriptor (invalid flags) + invalid/fail sName (must NOT be dereferenced)
    mem.writeDescriptor(cb + 24 * 9, nameInvalidAddr, 0x24001800u, 64, 0, 0, 0x80000000u);

    // Down[0]: too-long unterminated name
    mem.writeDescriptor(cb + 24 * 10, nameTooLong, 0x24002000u, 64, 0, 0, 0);
    // Down[1]: read failure on name
    mem.writeDescriptor(cb + 24 * 11, nameReadFail, 0x24002100u, 64, 0, 0, 0);
    // Down[2]: corrupt descriptor (wrOff >= bufferSize)
    mem.writeDescriptor(cb + 24 * 12, nameSysView, 0x24002200u, 64, 64, 0, 0);

    SeggerRttReader reader;
    RttEnumerationResult enumOut;
    const Result res = reader.enumerate(mem, cb, ramRanges, roRanges, enumOut, diagnostics);

    const bool touchedPeripheral = std::any_of(mem.readLog.begin(), mem.readLog.end(),
                                               [&](const auto& entry) { return entry.first == nameInvalidAddr; });
    expect(res.ok &&
               enumOut.validUpCount == 8 &&
               enumOut.validDownCount == 2 &&
               enumOut.corruptCount == 2 &&
               enumOut.unusedCount == 0 &&
               !touchedPeripheral &&
               enumOut.upBuffers[0].nameStatus == RttNameStatus::Null &&
               enumOut.upBuffers[0].name.empty() &&
               !enumOut.upBuffers[0].duplicateName &&
               enumOut.upBuffers[1].nameStatus == RttNameStatus::Empty &&
               enumOut.upBuffers[1].name.empty() &&
               !enumOut.upBuffers[1].duplicateName &&
               enumOut.upBuffers[2].name == "SysView" && enumOut.upBuffers[2].duplicateName &&
               enumOut.upBuffers[3].name == "SysView" && enumOut.upBuffers[3].duplicateName &&
               enumOut.duplicateUpNames == std::vector<std::string>{"SysView"} &&
               enumOut.duplicateDownNames.empty() &&
               enumOut.upBuffers[4].nameStatus == RttNameStatus::ShortRead &&
               enumOut.upBuffers[4].name.empty() && !enumOut.upBuffers[4].nameError.empty() &&
               enumOut.upBuffers[5].nameStatus == RttNameStatus::Ok &&
               enumOut.upBuffers[5].name == "OK" &&
               enumOut.upBuffers[6].nameStatus == RttNameStatus::Unterminated &&
               enumOut.upBuffers[6].name.empty() &&
               enumOut.upBuffers[7].nameStatus == RttNameStatus::InvalidAddress &&
               enumOut.upBuffers[7].name.empty() &&
               enumOut.upBuffers[8].status == RttDescriptorStatus::Corrupt &&
               !enumOut.upBuffers[8].valid &&
               enumOut.upBuffers[8].errorCode == "RttInvalidBufferFlags" &&
               enumOut.downBuffers[0].nameStatus == RttNameStatus::Unterminated &&
               enumOut.downBuffers[1].nameStatus == RttNameStatus::ReadFailed &&
               enumOut.downBuffers[2].status == RttDescriptorStatus::Corrupt &&
               enumOut.downBuffers[2].errorCode == "RttInvalidBufferLayout",
           "names-duplicates-short-read-and-corrupt-descriptors", failures);

    // Bounded max buffers check (>64 rejected) and short descriptor table read check
    mem.writeControlHeader(cb, 65, 0);
    const Result tooManyUp = reader.enumerate(mem, cb, ramRanges, roRanges, enumOut, diagnostics);
    expect(!tooManyUp.ok && tooManyUp.errorCode == "RttInvalidControlBlock",
           "max-up-buffers-bound-64", failures);

    mem.writeControlHeader(cb, 1, 65);
    const Result tooManyDown = reader.enumerate(mem, cb, ramRanges, roRanges, enumOut, diagnostics);
    expect(!tooManyDown.ok && tooManyDown.errorCode == "RttInvalidControlBlock",
           "max-down-buffers-bound-64", failures);

    mem.writeControlHeader(cb, 2, 1);
    mem.shortReads[cb + 24] = 48;  // expected 72 bytes -> short table read
    const Result shortTable = reader.enumerate(mem, cb, ramRanges, roRanges, enumOut, diagnostics);
    expect(!shortTable.ok && shortTable.errorCode == "RttInvalidBufferLayout",
           "short-descriptor-table-read-rejected", failures);
  }

  // 4. Shared bounded deadline across header, table, and name reads
  {
    static uint64_t gFakeNowMs = 0;
    static uint64_t gStepMs = 1;
    struct FakeClock {
      static std::chrono::steady_clock::time_point now() {
        return std::chrono::steady_clock::time_point(std::chrono::milliseconds(gFakeNowMs));
      }
      static void tick() { gFakeNowMs += gStepMs; }
    };

    MultiRegionMemory mem;
    mem.addRegion(0x24000000u, 0x10000u);
    const std::vector<RttMemoryRange> ramRanges = {{0x24000000u, 0x10000u}};
    const uint32_t cb = 0x24000100u;
    mem.writeControlHeader(cb, 4, 0);
    for (uint32_t i = 0; i < 4; ++i) {
      const uint32_t nameAddr = 0x24001000u + i * 64u;
      mem.writeCString(nameAddr, "ch-" + std::to_string(i));
      mem.writeDescriptor(cb + 24u * (1u + i), nameAddr, 0x24002000u + i * 64u, 64, 0, 0, 0);
    }

    SeggerRttReader reader;
    RttEnumerationResult enumOut;

    // 4a. Already expired before header read -> 0 reads
    gFakeNowMs = 100;
    mem.readLog.clear();
    mem.onRead = &FakeClock::tick;
    const Result preExpired = reader.enumerate(
        mem, cb, ramRanges, {}, enumOut, diagnostics,
        std::chrono::milliseconds(5),
        std::chrono::steady_clock::time_point(std::chrono::milliseconds(95)),
        &FakeClock::now);
    expect(!preExpired.ok && preExpired.errorCode == "ReadTimeout" && mem.readLog.empty(),
           "enumerate-timeout-before-header-read", failures);

    // 4b. Header read consumes entire budget -> stops before descriptor table read (1 read total)
    gFakeNowMs = 0;
    gStepMs = 5;
    mem.readLog.clear();
    const Result tableExpired = reader.enumerate(
        mem, cb, ramRanges, {}, enumOut, diagnostics,
        std::chrono::milliseconds(3),
        FakeClock::now(),
        &FakeClock::now);
    expect(!tableExpired.ok && tableExpired.errorCode == "ReadTimeout" && mem.readLog.size() == 1,
           "enumerate-timeout-before-table-read", failures);

    // 4c. Mid-name-loop deadline: 1ms header + 1ms table + 1ms ch-0 + 1ms ch-1 => expires at 4ms before ch-2
    gFakeNowMs = 0;
    gStepMs = 1;
    mem.readLog.clear();
    const Result midNameExpired = reader.enumerate(
        mem, cb, ramRanges, {}, enumOut, diagnostics,
        std::chrono::milliseconds(4),
        FakeClock::now(),
        &FakeClock::now);
    expect(!midNameExpired.ok && midNameExpired.errorCode == "ReadTimeout" &&
               mem.readLog.size() == 4 && enumOut.upBuffers.empty(),
           "enumerate-timeout-mid-name-loop-stops-early", failures);

    // 4d. Direct ReadTimeout from transport during name read aborts immediately (not swallowed as ReadFailed)
    mem.onRead = nullptr;
    mem.readLog.clear();
    mem.timeoutReads.insert(0x24001040u);  // ch-1
    const Result transportTimeout = reader.enumerate(
        mem, cb, ramRanges, {}, enumOut, diagnostics,
        std::chrono::milliseconds(100),
        FakeClock::now(),
        &FakeClock::now);
    expect(!transportTimeout.ok && transportTimeout.errorCode == "ReadTimeout" &&
               mem.readLog.size() == 4,
           "enumerate-propagates-transport-read-timeout", failures);
  }

  return failures;
}

class DownBufferMockMemory final : public RttMemory {
 public:
  struct Region {
    uint32_t address = 0;
    std::vector<uint8_t> data;
  };
  struct WriteEntry {
    uint32_t address = 0;
    std::vector<uint8_t> bytes;
  };

  std::vector<Region> regions;
  std::vector<std::pair<uint32_t, uint32_t>> readLog;
  std::vector<WriteEntry> writeLog;
  std::map<uint32_t, Result> failWriteAt;
  uint32_t failWriteOnAttempt = 0;
  Result failWriteAttemptResult = Result::error("RttMemoryWriteFailed", "injected attempt failure");
  uint32_t totalWriteAttempts = 0;
  void (*onRead)() = nullptr;
  void (*onWrite)(uint32_t address) = nullptr;

  void addRegion(uint32_t address, uint32_t size) {
    regions.push_back(Region{address, std::vector<uint8_t>(size, 0)});
  }

  void setBytes(uint32_t address, const std::vector<uint8_t>& input) {
    for (Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + input.size() <= end) {
        std::copy(input.begin(), input.end(), region.data.begin() + (address - region.address));
        return;
      }
    }
  }

  std::vector<uint8_t> slice(uint32_t address, uint32_t size) const {
    for (const Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + size <= end) {
        return std::vector<uint8_t>(region.data.begin() + (address - region.address),
                                    region.data.begin() + (address - region.address + size));
      }
    }
    return {};
  }

  void write32(uint32_t address, uint32_t value) {
    setBytes(address, {
        static_cast<uint8_t>(value & 0xFFu),
        static_cast<uint8_t>((value >> 8) & 0xFFu),
        static_cast<uint8_t>((value >> 16) & 0xFFu),
        static_cast<uint8_t>((value >> 24) & 0xFFu),
    });
  }

  uint32_t read32(uint32_t address) const {
    const std::vector<uint8_t> raw = slice(address, 4);
    if (raw.size() != 4) return 0;
    return static_cast<uint32_t>(raw[0])
        | (static_cast<uint32_t>(raw[1]) << 8)
        | (static_cast<uint32_t>(raw[2]) << 16)
        | (static_cast<uint32_t>(raw[3]) << 24);
  }

  void writeControlHeader(uint32_t address, uint32_t maxUp, uint32_t maxDown) {
    std::vector<uint8_t> header(24, 0);
    const char magic[] = "SEGGER RTT";
    std::copy(magic, magic + 10, header.begin());
    setBytes(address, header);
    write32(address + 16, maxUp);
    write32(address + 20, maxDown);
  }

  void writeDescriptor(uint32_t address, uint32_t sName, uint32_t pBuffer, uint32_t size,
                       uint32_t wrOff, uint32_t rdOff, uint32_t flags) {
    write32(address, sName);
    write32(address + 4, pBuffer);
    write32(address + 8, size);
    write32(address + 12, wrOff);
    write32(address + 16, rdOff);
    write32(address + 20, flags);
  }

  Result read(uint32_t address, uint32_t size, std::vector<uint8_t>& output,
              DapTransferDiagnostics&) override {
    readLog.emplace_back(address, size);
    if (onRead) onRead();
    const std::vector<uint8_t> raw = slice(address, size);
    if (raw.size() != size) {
      return Result::error("RttMemoryReadFailed", "oracle down-test read out of range");
    }
    output = raw;
    return Result::success();
  }

  Result write(uint32_t address, const std::vector<uint8_t>& input,
               DapTransferDiagnostics&) override {
    ++totalWriteAttempts;
    writeLog.push_back(WriteEntry{address, input});
    if (onWrite) onWrite(address);
    if (failWriteOnAttempt != 0 && totalWriteAttempts == failWriteOnAttempt) {
      return failWriteAttemptResult;
    }
    const auto failIt = failWriteAt.find(address);
    if (failIt != failWriteAt.end()) {
      return failIt->second;
    }
    for (Region& region : regions) {
      const uint64_t base = region.address;
      const uint64_t end = base + region.data.size();
      if (address >= base && static_cast<uint64_t>(address) + input.size() <= end) {
        std::copy(input.begin(), input.end(), region.data.begin() + (address - region.address));
        return Result::success();
      }
    }
    return Result::error("RttMemoryWriteFailed", "oracle down-test write out of range");
  }
};

int runDownBufferWriteTests() {
  int failures = 0;
  DapTransferDiagnostics diagnostics;

  // 1. Empty ring, linear write, wrap-around write, exact tail wrap, and RdOff preservation.
  {
    DownBufferMockMemory mem;
    mem.addRegion(0x24000000u, 0x10000u);
    const std::vector<RttMemoryRange> ramRanges = {{0x24000000u, 0x10000u}};
    const uint32_t cb = 0x24000100u;
    const uint32_t upBuf = 0x24001000u;
    const uint32_t downBuf = 0x24002000u;
    const uint32_t downDesc = cb + 24u * 2u;  // 1 Up, 1 Down => Down[0] at +48

    mem.writeControlHeader(cb, 1, 1);
    mem.writeDescriptor(cb + 24u, 0, upBuf, 16, 2, 0, 0);
    mem.setBytes(upBuf, {'U', 'P'});
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 0, 0, 0);  // empty ring, capacity = 7
    mem.setBytes(downBuf, std::vector<uint8_t>(8, 0xAA));

    SeggerRttReader reader;
    RttWriteResult out;
    const Result emptyWrite = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B', 'C'}, out, diagnostics);
    expect(emptyWrite.ok &&
               out.availableSpace == 7 &&
               out.requestedBytes == 3 &&
               out.writtenBytes == 3 &&
               out.committedBytes == 3 &&
               out.initialWrOff == 0 &&
               out.committedWrOff == 3 &&
               out.rdOff == 0 &&
               !out.wrapped && !out.shortWrite && !out.skipped &&
               out.firstSegmentWritten && !out.secondSegmentWritten &&
               out.wrOffWriteAttempted && out.wrOffCommitted &&
               out.completion == RttWriteCompletion::Completed &&
               out.failureStage == RttWriteFailureStage::None &&
               mem.writeLog.size() == 2 &&
               mem.writeLog[0].address == downBuf &&
               mem.writeLog[0].bytes == std::vector<uint8_t>({'A', 'B', 'C'}) &&
               mem.writeLog[1].address == downDesc + 12u &&
               mem.writeLog[1].bytes == std::vector<uint8_t>({3, 0, 0, 0}) &&
               mem.read32(downDesc + 12u) == 3u &&
               mem.read32(downDesc + 16u) == 0u,
           "down-empty-linear-write-order-and-preserves-rdoff", failures);

    // Wrap-around write: wrOff=6, rdOff=3, size=8 => avail=4 (slots 6,7,0,1; slot 2 sentinel)
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 6, 3, 0);
    mem.setBytes(downBuf, {0x00, 0x00, 0xEE, 0x11, 0x22, 0x33, 0x00, 0x00});
    mem.writeLog.clear();
    const Result wrapWrite = reader.writeDown(
        mem, cb, ramRanges, 0, {0x41, 0x42, 0x43, 0x44}, out, diagnostics);
    expect(wrapWrite.ok &&
               out.availableSpace == 4 &&
               out.wrapped && !out.shortWrite &&
               out.writtenBytes == 4 && out.committedBytes == 4 &&
               out.initialWrOff == 6 && out.committedWrOff == 2 &&
               out.rdOff == 3 && out.firstSegmentWritten && out.secondSegmentWritten &&
               out.wrOffWriteAttempted && out.wrOffCommitted &&
               out.completion == RttWriteCompletion::Completed &&
               mem.writeLog.size() == 3 &&
               mem.writeLog[0].address == downBuf + 6u &&
               mem.writeLog[0].bytes == std::vector<uint8_t>({0x41, 0x42}) &&
               mem.writeLog[1].address == downBuf &&
               mem.writeLog[1].bytes == std::vector<uint8_t>({0x43, 0x44}) &&
               mem.writeLog[2].address == downDesc + 12u &&
               mem.writeLog[2].bytes == std::vector<uint8_t>({2, 0, 0, 0}) &&
               mem.slice(downBuf, 8) == std::vector<uint8_t>({0x43, 0x44, 0xEE, 0x11, 0x22, 0x33, 0x41, 0x42}) &&
               mem.read32(downDesc + 12u) == 2u &&
               mem.read32(downDesc + 16u) == 3u,
           "down-wrap-around-write-sequence-and-sentinel-preserved", failures);

    // Exact-tail wrap: wrOff=5, rdOff=1, size=8 => avail=3 (slots 5,6,7), nextWrOff=0
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 5, 1, 0);
    mem.writeLog.clear();
    const Result tailWrap = reader.writeDown(mem, cb, ramRanges, 0, {'X', 'Y', 'Z'}, out, diagnostics);
    expect(tailWrap.ok && !out.wrapped && out.committedBytes == 3 &&
               out.committedWrOff == 0 && out.rdOff == 1 &&
               mem.writeLog.size() == 2 &&
               mem.writeLog[0].address == downBuf + 5u &&
               mem.writeLog[1].address == downDesc + 12u &&
               mem.read32(downDesc + 12u) == 0u &&
               mem.read32(downDesc + 16u) == 1u,
           "down-exact-tail-wrap-sets-wroff-zero", failures);

    // Coexistence with Up-buffer start/read (writeDown does not touch Up-buffer or start state)
    RttReadResult upOut;
    expect(reader.start(mem, cb, ramRanges, diagnostics).ok &&
               reader.read(mem, 0, 8, upOut, diagnostics).ok &&
               upOut.bytes == std::vector<uint8_t>({'U', 'P'}) &&
               mem.read32(cb + 24u + 16u) == 2u &&
               mem.read32(downDesc + 12u) == 0u,
           "down-write-coexists-with-up-buffer-rtt-log", failures);
    reader.stop();
  }

  // 2. Full buffer & determinable short writes (Mode 0 SKIP vs Mode 1 TRIM).
  {
    DownBufferMockMemory mem;
    mem.addRegion(0x20000000u, 0x4000u);
    const std::vector<RttMemoryRange> ramRanges = {{0x20000000u, 0x4000u}};
    const uint32_t cb = 0x20000100u;
    const uint32_t downBuf = 0x20001000u;
    const uint32_t downDesc = cb + 24u * 2u;
    mem.writeControlHeader(cb, 1, 1);
    mem.writeDescriptor(cb + 24u, 0, 0x20000800u, 16, 0, 0, 0);

    SeggerRttReader reader;
    RttWriteResult out;

    // Mode 0 SKIP when full (wrOff=7, rdOff=0 => avail=0)
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 7, 0, 0);
    mem.writeLog.clear();
    const Result fullSkip = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
    expect(fullSkip.ok && out.availableSpace == 0 && out.shortWrite && out.skipped &&
               out.committedBytes == 0 && out.committedWrOff == 7 &&
               out.completion == RttWriteCompletion::NotStarted &&
               mem.writeLog.empty(),
           "down-full-mode0-skip-writes-nothing", failures);

    // Mode 0 SKIP when partial space (avail=3, requested=4) -> skips atomically
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 2, 6, 0);  // avail = 6 - 2 - 1 = 3
    mem.writeLog.clear();
    const Result partialSkip = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B', 'C', 'D'}, out, diagnostics);
    expect(partialSkip.ok && out.availableSpace == 3 && out.shortWrite && out.skipped &&
               out.committedBytes == 0 && out.committedWrOff == 2 &&
               out.completion == RttWriteCompletion::NotStarted &&
               mem.writeLog.empty(),
           "down-partial-mode0-skip-writes-nothing", failures);

    // Mode 1 TRIM when full (wrOff=2, rdOff=3 => avail=0)
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 2, 3, 1);
    mem.writeLog.clear();
    const Result fullTrim = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B'}, out, diagnostics);
    expect(fullTrim.ok && out.availableSpace == 0 && out.shortWrite && !out.skipped &&
               out.committedBytes == 0 && out.committedWrOff == 2 &&
               out.completion == RttWriteCompletion::NotStarted &&
               mem.writeLog.empty(),
           "down-full-mode1-trim-writes-nothing", failures);

    // Mode 1 TRIM when partial space with wrap (wrOff=6, rdOff=2 => avail=3; req=5 => writes 3 wrapped)
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 6, 2, 1);
    mem.setBytes(downBuf, std::vector<uint8_t>(8, 0xAA));
    mem.writeLog.clear();
    const Result partialTrim = reader.writeDown(
        mem, cb, ramRanges, 0, {'1', '2', '3', '4', '5'}, out, diagnostics);
    expect(partialTrim.ok && out.availableSpace == 3 && out.shortWrite && !out.skipped &&
               out.wrapped && out.requestedBytes == 5 && out.writtenBytes == 3 &&
               out.committedBytes == 3 && out.committedWrOff == 1 && out.rdOff == 2 &&
               out.completion == RttWriteCompletion::Partial &&
               mem.writeLog.size() == 3 &&
               mem.slice(downBuf, 8) == std::vector<uint8_t>({'3', 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, '1', '2'}) &&
               mem.read32(downDesc + 12u) == 1u &&
               mem.read32(downDesc + 16u) == 2u,
           "down-partial-mode1-trim-wrapped-short-write", failures);

    // Size=1 degenerate ring buffer: avail=0, Mode 1 writes 0 bytes without underflow
    mem.writeDescriptor(downDesc, 0, downBuf, 1, 0, 0, 1);
    mem.writeLog.clear();
    const Result sizeOne = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
    expect(sizeOne.ok && out.availableSpace == 0 && out.shortWrite && out.committedBytes == 0 &&
               mem.writeLog.empty(),
           "down-size-one-ring-no-underflow", failures);
  }

  // 3. Invalid inputs, control blocks, descriptors, and offsets (zero writes).
  {
    DownBufferMockMemory mem;
    mem.addRegion(0x20000000u, 0x1000u);
    mem.addRegion(0x20001000u, 0x1000u);
    const std::vector<RttMemoryRange> ramRanges = {
        {0x20000000u, 0x1000u},
        {0x20001000u, 0x1000u},
    };
    const uint32_t cb = 0x20000100u;
    const uint32_t downDesc = cb + 24u * 2u;
    mem.writeControlHeader(cb, 1, 2);
    mem.writeDescriptor(cb + 24u, 0, 0x20000400u, 16, 0, 0, 0);

    SeggerRttReader reader;
    RttWriteResult out;
    expect(!reader.writeDown(mem, cb, ramRanges, 0, {}, out, diagnostics).ok &&
               out.failureStage == RttWriteFailureStage::Validation && mem.writeLog.empty(),
           "down-rejects-empty-payload", failures);
    expect(!reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics,
                             std::chrono::milliseconds(0)).ok &&
               out.failureStage == RttWriteFailureStage::Validation && mem.writeLog.empty(),
           "down-rejects-nonpositive-timeout", failures);
    expect(!reader.writeDown(mem, 0u, ramRanges, 0, {'A'}, out, diagnostics).ok &&
               mem.writeLog.empty(),
           "down-rejects-null-cb", failures);
    expect(!reader.writeDown(mem, 0x20005000u, ramRanges, 0, {'A'}, out, diagnostics).ok &&
               mem.writeLog.empty(),
           "down-rejects-oob-cb", failures);

    // Buffer index out of range
    const Result badIndex = reader.writeDown(mem, cb, ramRanges, 2, {'A'}, out, diagnostics);
    expect(!badIndex.ok && badIndex.errorCode == "RttInvalidBufferIndex" && mem.writeLog.empty(),
           "down-rejects-invalid-buffer-index", failures);

    // Unused all-zero Down descriptor
    mem.writeDescriptor(downDesc, 0, 0, 0, 0, 0, 0);
    const Result unusedDesc = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
    expect(!unusedDesc.ok && unusedDesc.errorCode == "RttInvalidBufferLayout" && mem.writeLog.empty(),
           "down-rejects-unused-descriptor", failures);

    // Cross-region ring buffer
    mem.writeDescriptor(downDesc, 0, 0x20000FFCu, 8, 0, 0, 0);
    const Result crossRegion = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
    expect(!crossRegion.ok && crossRegion.errorCode == "RttInvalidBufferLayout" && mem.writeLog.empty(),
           "down-rejects-cross-region-buffer", failures);

    // Invalid WrOff / RdOff (>= bufferSize)
    mem.writeDescriptor(downDesc, 0, 0x20000400u, 8, 8, 0, 0);
    const Result badWr = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
    expect(!badWr.ok && badWr.errorCode == "RttInvalidBufferLayout" && mem.writeLog.empty(),
           "down-rejects-wroff-oob", failures);

    mem.writeDescriptor(downDesc, 0, 0x20000400u, 8, 0, 8, 0);
    const Result badRd = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
    expect(!badRd.ok && badRd.errorCode == "RttInvalidBufferLayout" && mem.writeLog.empty(),
           "down-rejects-rdoff-oob", failures);

    // Invalid flags (mode 3 and reserved bit)
    for (const uint32_t badFlags : {3u, 4u}) {
      mem.writeDescriptor(downDesc, 0, 0x20000400u, 8, 0, 0, badFlags);
      const Result badFlagRes = reader.writeDown(mem, cb, ramRanges, 0, {'A'}, out, diagnostics);
      expect(!badFlagRes.ok && badFlagRes.errorCode == "RttInvalidBufferFlags" && mem.writeLog.empty(),
             badFlags == 3 ? "down-rejects-flags-mode3" : "down-rejects-flags-reserved-bit", failures);
    }

    // Ring overlapping RTT control block (24-byte header + Up/Down descriptors) vs adjacent valid boundaries
    // cb = 0x20000100, maxUp=1, maxDown=2 => cbTotal = 24 + 3*24 = 96 bytes => [0x20000100, 0x20000160)
    const uint32_t cbEnd = cb + 24u * 4u;
    struct OverlapCase {
      const char* name;
      uint32_t bufAddr;
      uint32_t bufSize;
    };
    const OverlapCase overlapCases[] = {
        {"down-rejects-ring-at-cb-header", cb, 8u},
        {"down-rejects-ring-ending-in-cb-header", cb - 7u, 8u},
        {"down-rejects-ring-in-up-descriptor", cb + 24u + 4u, 8u},
        {"down-rejects-ring-in-down-descriptor", downDesc + 12u, 8u},
        {"down-rejects-ring-at-last-byte-of-table", cbEnd - 1u, 8u},
        {"down-rejects-ring-enclosing-cb", cb - 16u, 96u + 32u},
    };
    for (const OverlapCase& c : overlapCases) {
      mem.writeDescriptor(downDesc, 0, c.bufAddr, c.bufSize, 0, 0, 1);
      const std::vector<uint8_t> cbBefore = mem.slice(cb, 96u);
      mem.writeLog.clear();
      const Result overlapRes = reader.writeDown(
          mem, cb, ramRanges, 0, {0x12, 0x34, 0x56, 0x78}, out, diagnostics);
      expect(!overlapRes.ok && overlapRes.errorCode == "RttInvalidBufferLayout" &&
                 out.failureStage == RttWriteFailureStage::Descriptor &&
                 out.completion == RttWriteCompletion::NotStarted &&
                 mem.writeLog.empty() && mem.slice(cb, 96u) == cbBefore,
             c.name, failures);
    }

    // Adjacent immediately BEFORE cb ([cb - 8, cb)) and immediately AFTER cb table ([cbEnd, cbEnd + 8)) are valid.
    mem.writeDescriptor(downDesc, 0, cb - 8u, 8u, 0, 0, 1);
    mem.setBytes(cb - 8u, std::vector<uint8_t>(8u, 0xAA));
    const std::vector<uint8_t> upDescBeforeBefore = mem.slice(cb + 24u, 24u);
    mem.writeLog.clear();
    const Result adjBefore = reader.writeDown(mem, cb, ramRanges, 0, {0xA1, 0xA2}, out, diagnostics);
    expect(adjBefore.ok && out.committedBytes == 2 && out.committedWrOff == 2 &&
               mem.slice(cb - 8u, 8u) == std::vector<uint8_t>({0xA1, 0xA2, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA}) &&
               mem.slice(cb + 24u, 24u) == upDescBeforeBefore &&
               mem.read32(downDesc + 12u) == 2u && mem.read32(downDesc + 16u) == 0u,
           "down-allows-ring-adjacent-before-cb", failures);

    mem.writeDescriptor(downDesc, 0, cbEnd, 8u, 0, 0, 1);
    mem.setBytes(cbEnd, std::vector<uint8_t>(8u, 0xBB));
    const std::vector<uint8_t> cbHeaderBeforeAfter = mem.slice(cb, 24u);
    mem.writeLog.clear();
    const Result adjAfter = reader.writeDown(mem, cb, ramRanges, 0, {0xB1, 0xB2, 0xB3}, out, diagnostics);
    expect(adjAfter.ok && out.committedBytes == 3 && out.committedWrOff == 3 &&
               mem.slice(cbEnd, 8u) == std::vector<uint8_t>({0xB1, 0xB2, 0xB3, 0xBB, 0xBB, 0xBB, 0xBB, 0xBB}) &&
               mem.slice(cb, 24u) == cbHeaderBeforeAfter &&
               mem.read32(downDesc + 12u) == 3u && mem.read32(downDesc + 16u) == 0u,
           "down-allows-ring-adjacent-after-cb-table", failures);

    // High 32-bit address boundary without uint32/uint64 overflow
    DownBufferMockMemory highMem;
    highMem.addRegion(0xFFFFF000u, 0x1000u);
    const std::vector<RttMemoryRange> highRanges = {{0xFFFFF000u, 0x1000u}};
    const uint32_t highCb = 0xFFFFF000u;
    const uint32_t highCbEnd = highCb + 24u * 3u;
    highMem.writeControlHeader(highCb, 1, 1);
    highMem.writeDescriptor(highCb + 24u, 0, 0xFFFFF800u, 16u, 0, 0, 0);
    highMem.writeDescriptor(highCb + 48u, 0, highCbEnd - 4u, 0x1000u - (highCbEnd - 4u - highCb), 0, 0, 1);
    const Result highOverlap = highMem.writeLog.empty()
        ? reader.writeDown(highMem, highCb, highRanges, 0, {1}, out, diagnostics)
        : Result::success();
    expect(!highOverlap.ok && highOverlap.errorCode == "RttInvalidBufferLayout" && highMem.writeLog.empty(),
           "down-high-address-overlap-no-overflow", failures);
    highMem.writeDescriptor(highCb + 48u, 0, highCbEnd, 0x1000u - (highCbEnd - highCb), 0, 0, 1);
    const Result highAdj = reader.writeDown(highMem, highCb, highRanges, 0, {0x5A}, out, diagnostics);
    expect(highAdj.ok && out.committedBytes == 1, "down-high-address-adjacent-no-overflow", failures);
  }

  // 4. Data segment failures, segment1-ok/segment2-fail, commit WrOff failures, and unknown completion (NO retry).
  {
    DownBufferMockMemory mem;
    mem.addRegion(0x24000000u, 0x4000u);
    const std::vector<RttMemoryRange> ramRanges = {{0x24000000u, 0x4000u}};
    const uint32_t cb = 0x24000100u;
    const uint32_t downBuf = 0x24001000u;
    const uint32_t downDesc = cb + 24u * 2u;
    mem.writeControlHeader(cb, 1, 1);
    mem.writeDescriptor(cb + 24u, 0, 0x24000800u, 16, 0, 0, 0);

    SeggerRttReader reader;
    RttWriteResult out;

    // 4a. Segment 1 clean failure -> WrOff never touched, no retry
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 6, 3, 0);
    mem.writeLog.clear();
    mem.totalWriteAttempts = 0;
    mem.failWriteAt.clear();
    mem.failWriteAt[downBuf + 6u] = Result::error("RttMemoryWriteFailed", "data1 failed");
    const Result seg1Fail = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B', 'C', 'D'}, out, diagnostics);
    expect(!seg1Fail.ok && seg1Fail.errorCode == "RttMemoryWriteFailed" &&
               out.failureStage == RttWriteFailureStage::DataFirst &&
               !out.firstSegmentWritten && !out.secondSegmentWritten &&
               !out.wrOffWriteAttempted && !out.wrOffCommitted &&
               out.writtenBytes == 0 && out.committedBytes == 0 &&
               out.committedWrOff == 6 &&
               out.completion == RttWriteCompletion::NotStarted &&
               mem.totalWriteAttempts == 1 && mem.read32(downDesc + 12u) == 6u,
           "down-seg1-clean-fail-no-retry-no-commit", failures);

    // 4b. Segment 1 unknown outcome -> completion=Unknown, no retry
    mem.writeLog.clear();
    mem.totalWriteAttempts = 0;
    mem.failWriteAt[downBuf + 6u] = Result::error("OutcomeUnknown", "usb status unknown");
    const Result seg1Unknown = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B'}, out, diagnostics);
    expect(!seg1Unknown.ok && seg1Unknown.errorCode == "OutcomeUnknown" &&
               out.failureStage == RttWriteFailureStage::DataFirst &&
               !out.firstSegmentWritten && !out.wrOffWriteAttempted && !out.wrOffCommitted &&
               out.committedBytes == 0 &&
               out.completion == RttWriteCompletion::Unknown && !out.retryable &&
               mem.totalWriteAttempts == 1 && mem.read32(downDesc + 12u) == 6u,
           "down-seg1-unknown-outcome-no-retry", failures);

    // 4c. Segment 1 succeeds, segment 2 fails -> WrOff NOT written, committedBytes=0, writtenBytes=2
    mem.failWriteAt.clear();
    mem.failWriteAt[downBuf] = Result::error("DeviceRemoved", "probe unplugged on seg2");
    mem.writeLog.clear();
    mem.totalWriteAttempts = 0;
    const Result seg2Fail = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B', 'C', 'D'}, out, diagnostics);
    expect(!seg2Fail.ok && seg2Fail.errorCode == "DeviceRemoved" &&
               out.failureStage == RttWriteFailureStage::DataSecond &&
               out.firstSegmentWritten && !out.secondSegmentWritten &&
               !out.wrOffWriteAttempted && !out.wrOffCommitted &&
               out.writtenBytes == 2 && out.committedBytes == 0 &&
               out.committedWrOff == 6 &&
               out.completion == RttWriteCompletion::Unknown && !out.retryable &&
               mem.writeLog.size() == 2 &&
               mem.writeLog[0].address == downBuf + 6u &&
               mem.writeLog[1].address == downBuf &&
               mem.read32(downDesc + 12u) == 6u &&
               mem.read32(downDesc + 16u) == 3u,
           "down-seg1-ok-seg2-fail-does-not-commit-wroff", failures);

    // 4d. Data written completely, WrOff commit fails cleanly -> never fake-reports committed
    mem.failWriteAt.clear();
    mem.failWriteAt[downDesc + 12u] = Result::error("DapAckFault", "SWD FAULT on WrOff");
    mem.writeLog.clear();
    mem.totalWriteAttempts = 0;
    const Result wrOffCleanFail = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B', 'C', 'D'}, out, diagnostics);
    expect(!wrOffCleanFail.ok && wrOffCleanFail.errorCode == "DapAckFault" &&
               out.failureStage == RttWriteFailureStage::CommitWrOff &&
               out.firstSegmentWritten && out.secondSegmentWritten &&
               out.wrOffWriteAttempted && !out.wrOffCommitted &&
               out.writtenBytes == 4 && out.committedBytes == 0 &&
               out.committedWrOff == 6 &&
               out.completion == RttWriteCompletion::NotStarted &&
               mem.writeLog.size() == 3 && mem.read32(downDesc + 12u) == 6u,
           "down-data-written-wroff-clean-fail-no-fake-commit", failures);

    // 4e. Data written completely, WrOff commit has unknown completion -> completion=Unknown, no retry
    for (const char* unknownCode : {"WriteTimeout", "WriteCompletedLate", "OutcomeUnknown", "MalformedResponse"}) {
      mem.failWriteAt[downDesc + 12u] = Result::error(unknownCode, "unknown WrOff completion");
      mem.writeLog.clear();
      mem.totalWriteAttempts = 0;
      const Result wrOffUnknown = reader.writeDown(mem, cb, ramRanges, 0, {'A', 'B', 'C', 'D'}, out, diagnostics);
      expect(!wrOffUnknown.ok && wrOffUnknown.errorCode == unknownCode &&
                 out.failureStage == RttWriteFailureStage::CommitWrOff &&
                 out.firstSegmentWritten && out.secondSegmentWritten &&
                 out.wrOffWriteAttempted && !out.wrOffCommitted &&
                 out.writtenBytes == 4 && out.committedBytes == 0 &&
                 out.committedWrOff == 6 &&
                 out.completion == RttWriteCompletion::Unknown && !out.retryable &&
                 mem.writeLog.size() == 3 && mem.read32(downDesc + 12u) == 6u,
             unknownCode, failures);
    }
  }

  // 5. Mode 2 (BLOCK_IF_FIFO_FULL) + FakeClock timeout before/after partial commit & stage deadlines.
  {
    static uint64_t gNowMs = 0;
    static uint64_t gTickOnReadMs = 0;
    static uint64_t gTickOnSleepMs = 1;
    static DownBufferMockMemory* gMem = nullptr;
    static uint32_t gDownDesc = 0;
    static uint32_t gTargetAdvanceAfterSleeps = 0;
    static uint32_t gSleepCount = 0;
    static uint32_t gNewRdOff = 0;
    static uint32_t gConcurrentWrOffAfterSleeps = 0;
    static uint32_t gConcurrentWrOffValue = 0;

    struct DownFakeClock {
      static std::chrono::steady_clock::time_point now() {
        return std::chrono::steady_clock::time_point(std::chrono::milliseconds(gNowMs));
      }
      static void onRead() { gNowMs += gTickOnReadMs; }
      static void onSleep(std::chrono::milliseconds) {
        ++gSleepCount;
        gNowMs += gTickOnSleepMs;
        if (gMem && gTargetAdvanceAfterSleeps != 0 && gSleepCount == gTargetAdvanceAfterSleeps) {
          gMem->write32(gDownDesc + 16u, gNewRdOff);
        }
        if (gMem && gConcurrentWrOffAfterSleeps != 0 && gSleepCount == gConcurrentWrOffAfterSleeps) {
          gMem->write32(gDownDesc + 12u, gConcurrentWrOffValue);
        }
      }
    };

    DownBufferMockMemory mem;
    mem.addRegion(0x24000000u, 0x4000u);
    const std::vector<RttMemoryRange> ramRanges = {{0x24000000u, 0x4000u}};
    const uint32_t cb = 0x24000100u;
    const uint32_t downBuf = 0x24001000u;
    const uint32_t downDesc = cb + 24u * 2u;
    mem.writeControlHeader(cb, 1, 1);
    mem.writeDescriptor(cb + 24u, 0, 0x24000800u, 16, 0, 0, 0);

    gMem = &mem;
    gDownDesc = downDesc;
    SeggerRttReader reader;
    RttWriteResult out;

    // 5a. Mode 2 full initially -> target advances RdOff before deadline -> completes!
    gNowMs = 0;
    gTickOnReadMs = 0;
    gTickOnSleepMs = 1;
    gSleepCount = 0;
    gTargetAdvanceAfterSleeps = 2;
    gNewRdOff = 4;  // from wrOff=7, rdOff=0 (full) -> rdOff=4 frees slots 7,0,1,2 (4 bytes)
    gConcurrentWrOffAfterSleeps = 0;
    mem.onRead = &DownFakeClock::onRead;
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 7, 0, 2);
    mem.writeLog.clear();
    const Result blockOk = reader.writeDown(
        mem, cb, ramRanges, 0, {'W', 'X', 'Y'}, out, diagnostics,
        std::chrono::milliseconds(10), DownFakeClock::now(), &DownFakeClock::now, &DownFakeClock::onSleep);
    expect(blockOk.ok && out.committedBytes == 3 && out.committedWrOff == 2 &&
               out.rdOff == 4 && out.wrapped &&
               out.completion == RttWriteCompletion::Completed &&
               mem.read32(downDesc + 12u) == 2u && mem.read32(downDesc + 16u) == 4u,
           "down-mode2-unblocks-before-deadline", failures);

    // 5b. Mode 2 full initially -> deadline expires before RdOff advances -> WriteTimeout, NotStarted
    gNowMs = 0;
    gSleepCount = 0;
    gTargetAdvanceAfterSleeps = 0;
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 7, 0, 2);
    mem.writeLog.clear();
    const Result blockTimeout = reader.writeDown(
        mem, cb, ramRanges, 0, {'W', 'X'}, out, diagnostics,
        std::chrono::milliseconds(3), DownFakeClock::now(), &DownFakeClock::now, &DownFakeClock::onSleep);
    expect(!blockTimeout.ok && blockTimeout.errorCode == "WriteTimeout" &&
               out.failureStage == RttWriteFailureStage::PollWait &&
               out.completion == RttWriteCompletion::NotStarted &&
               out.committedBytes == 0 && out.committedWrOff == 7 &&
               mem.writeLog.empty(),
           "down-mode2-timeout-full-reports-not-started", failures);

    // 5c. Mode 2 multi-chunk: chunk 1 commits 3 bytes (avail=3, req=5), chunk 2 times out waiting -> Partial(3)
    gNowMs = 0;
    gSleepCount = 0;
    gTargetAdvanceAfterSleeps = 0;
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 2, 6, 2);  // avail = 3 -> commits 3 -> wrOff=5, rdOff=6 (full)
    mem.writeLog.clear();
    const Result partialTimeout = reader.writeDown(
        mem, cb, ramRanges, 0, {'A', 'B', 'C', 'D', 'E'}, out, diagnostics,
        std::chrono::milliseconds(3), DownFakeClock::now(), &DownFakeClock::now, &DownFakeClock::onSleep);
    expect(!partialTimeout.ok && partialTimeout.errorCode == "WriteTimeout" &&
               out.failureStage == RttWriteFailureStage::PollWait &&
               out.completion == RttWriteCompletion::Partial &&
               out.shortWrite && out.requestedBytes == 5 &&
               out.writtenBytes == 3 && out.committedBytes == 3 &&
               out.initialWrOff == 2 && out.committedWrOff == 5 &&
               mem.read32(downDesc + 12u) == 5u &&
               mem.slice(downBuf + 2u, 3) == std::vector<uint8_t>({'A', 'B', 'C'}),
           "down-mode2-partial-commit-before-timeout", failures);

    // 5d. Mode 2 concurrent WrOff modification detected during poll
    gNowMs = 0;
    gSleepCount = 0;
    gConcurrentWrOffAfterSleeps = 1;
    gConcurrentWrOffValue = 1;
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 7, 0, 2);
    const Result concurrentWr = reader.writeDown(
        mem, cb, ramRanges, 0, {'A'}, out, diagnostics,
        std::chrono::milliseconds(5), DownFakeClock::now(), &DownFakeClock::now, &DownFakeClock::onSleep);
    expect(!concurrentWr.ok && concurrentWr.errorCode == "RttBufferOverrun" &&
               out.failureStage == RttWriteFailureStage::PollWait &&
               out.committedBytes == 0,
           "down-mode2-detects-concurrent-wroff-change", failures);

    // 5d-2. Mode 2 descriptor mutated to overlap CB during PollWait is rejected before writing
    gNowMs = 0;
    gSleepCount = 0;
    gConcurrentWrOffAfterSleeps = 0;
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 7, 0, 2);
    mem.writeLog.clear();
    static uint32_t gPollMutationCount = 0;
    gPollMutationCount = 0;
    mem.onRead = []() {
      ++gPollMutationCount;
      // Call 1: CB header, Call 2: initial Desc (valid, full), Call 3: PollWait re-read -> mutate pBuffer!
      if (gPollMutationCount == 3 && gMem) {
        gMem->write32(gDownDesc + 4u, 0x24000100u);
      }
      DownFakeClock::onRead();
    };
    const Result pollMutatedOverlap = reader.writeDown(
        mem, cb, ramRanges, 0, {'A'}, out, diagnostics,
        std::chrono::milliseconds(5), DownFakeClock::now(), &DownFakeClock::now, &DownFakeClock::onSleep);
    expect(!pollMutatedOverlap.ok && pollMutatedOverlap.errorCode == "RttInvalidBufferLayout" &&
               out.failureStage == RttWriteFailureStage::PollWait &&
               mem.writeLog.empty(),
           "down-mode2-poll-revalidation-rejects-cb-overlap", failures);
    mem.onRead = &DownFakeClock::onRead;

    // 5e. Deadline expires after data written, BEFORE WrOff write -> CommitWrOff, wrOffWriteAttempted=false
    gConcurrentWrOffAfterSleeps = 0;
    gNowMs = 0;
    gTickOnReadMs = 1;
    static uint64_t gTickOnWriteMs = 2;
    mem.onWrite = [](uint32_t) { gNowMs += gTickOnWriteMs; };
    // Reads: CB (+1ms), Desc (+1ms) => 2ms. Write seg1 (+2ms) => 4ms. Deadline=4ms expires before seg2 or WrOff!
    mem.writeDescriptor(downDesc, 0, downBuf, 8, 6, 3, 0);
    mem.writeLog.clear();
    const Result expireBeforeWrOff = reader.writeDown(
        mem, cb, ramRanges, 0, {'P', 'Q'}, out, diagnostics,  // fits in tail (6,7), no seg2
        std::chrono::milliseconds(4), DownFakeClock::now(), &DownFakeClock::now, &DownFakeClock::onSleep);
    expect(!expireBeforeWrOff.ok && expireBeforeWrOff.errorCode == "WriteTimeout" &&
               out.failureStage == RttWriteFailureStage::CommitWrOff &&
               out.firstSegmentWritten && !out.wrOffWriteAttempted && !out.wrOffCommitted &&
               out.writtenBytes == 2 && out.committedBytes == 0 &&
               out.completion == RttWriteCompletion::NotStarted &&
               mem.writeLog.size() == 1 && mem.read32(downDesc + 12u) == 6u,
           "down-deadline-before-wroff-write-does-not-attempt-wroff", failures);

    mem.onRead = nullptr;
    mem.onWrite = nullptr;
    gMem = nullptr;
  }

  return failures;
}

}  // namespace

int main() {
  const int failures =
      runLegacyBaselineTests() + runRangeAndEnumerationTests() + runDownBufferWriteTests();
  if (failures == 0) {
    std::cout << "segger-rtt-tests: PASS\n";
    return 0;
  }
  std::cerr << "segger-rtt-tests: " << failures << " failure(s)\n";
  return 1;
}
