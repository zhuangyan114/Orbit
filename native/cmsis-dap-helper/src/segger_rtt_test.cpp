#include "segger_rtt.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

using cmsis_dap_helper::DapTransferDiagnostics;
using cmsis_dap_helper::RttMemory;
using cmsis_dap_helper::RttReadResult;
using cmsis_dap_helper::Result;
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

void expect(bool condition, const char* name, int& failures) {
  if (!condition) {
    std::cerr << "FAIL " << name << '\n';
    ++failures;
  }
}

int run() {
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

}  // namespace

int main() {
  const int failures = run();
  if (failures == 0) {
    std::cout << "segger-rtt-tests: PASS\n";
    return 0;
  }
  std::cerr << "segger-rtt-tests: " << failures << " failure(s)\n";
  return 1;
}
