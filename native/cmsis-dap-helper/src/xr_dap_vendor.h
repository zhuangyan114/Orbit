#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

// XR-DAP vendor extension (CMSIS-DAP vendor commands 0x80..0x85): probe-side
// memory reads and periodic sampling. Byte layout follows the XR-DAP protocol
// document (XRDAP-ESP docs/protocol.md, section 3). A probe without the
// extension answers 0x80 with the single byte 0xFF.
//
// While sampling runs, the probe accepts only DAP_Info, DAP_HostStatus and
// 0x80..0x86; every other command is answered with 0xFF and not executed.
// After vendor commands DP SELECT, AP CSW and TAR must be treated as unknown.

constexpr uint8_t kXrCmdInfo = 0x80;
constexpr uint8_t kXrCmdRead = 0x81;
constexpr uint8_t kXrCmdSubSet = 0x83;
constexpr uint8_t kXrCmdSubCtrl = 0x84;
constexpr uint8_t kXrCmdSubRead = 0x85;

constexpr uint8_t kXrSubStop = 0;
constexpr uint8_t kXrSubStart = 1;

constexpr uint32_t kXrFeatureRead = 1u << 0;
constexpr uint32_t kXrFeatureSampling = 1u << 2;
constexpr uint32_t kXrFeatureWide = 1u << 3;

constexpr size_t kXrMaxDerefs = 8;
constexpr size_t kXrPacketSize = 1024;
constexpr size_t kXrSubReadHeader = 24;

struct XrInfo {
  uint8_t version = 0;
  uint32_t features = 0;
  uint16_t maxItems = 0;
  uint8_t maxDepth = 0;
  uint32_t bufferBytes = 0;
  uint64_t probeNowUs = 0;
  uint32_t accessUs = 0;
};

// One probe-resolved location: base, then n pointer reads, then final offset.
struct XrItem {
  uint8_t ap = 0;
  uint16_t id = 0;
  uint8_t size = 4;  // 1, 2, 4 or 8
  uint32_t base = 0;
  std::vector<int16_t> derefs;
  int16_t finalOffset = 0;
  uint16_t div = 1;    // sampling only
  uint16_t phase = 0;  // sampling only
};

struct XrReadValue {
  uint16_t id = 0;
  uint8_t status = 0;  // 0 = ok
  std::vector<uint8_t> bytes;
};

struct XrSubSetReply {
  uint8_t status = 0;
  uint16_t maxFrameBytes = 0;
  uint32_t estFrameUs = 0;
};

struct XrFrameValue {
  size_t item = 0;  // index into the subscribed item list
  bool ok = false;
  std::vector<uint8_t> bytes;
};

struct XrFrame {
  uint32_t tick = 0;
  uint64_t timestampUs = 0;  // probe clock, 48 bits
  std::vector<XrFrameValue> values;
};

struct XrSubReadReply {
  uint64_t probeNowUs = 0;
  uint32_t pendingBytes = 0;
  uint32_t droppedFrames = 0;
  uint32_t skippedTicks = 0;
  std::vector<XrFrame> frames;
};

// Human-readable name for a vendor overall status byte.
const char* xrStatusName(uint8_t status);

// Returns an error result for a non-zero overall status; maps 0x04 (no target)
// and 0x02 (state) onto the shared error codes.
Result xrStatusResult(uint8_t command, uint8_t status);

bool xrItemValid(const XrItem& item);
void xrAppendItem(std::vector<uint8_t>& out, const XrItem& item);

std::vector<uint8_t> xrInfoRequest();
Result xrParseInfo(const std::vector<uint8_t>& response, XrInfo& out);

std::vector<uint8_t> xrReadRequest(const std::vector<XrItem>& items);
Result xrParseRead(const std::vector<uint8_t>& response, const std::vector<XrItem>& items,
                   std::vector<XrReadValue>& out);

std::vector<uint8_t> xrSubSetRequest(uint32_t periodUs, bool stopWhenFull,
                                     const std::vector<XrItem>& items);
// Parses the reply, including the 0x03 resource reply that still carries the
// frame estimate. Returns ok for status 0 and 3; the caller checks out.status.
Result xrParseSubSet(const std::vector<uint8_t>& response, XrSubSetReply& out);

std::vector<uint8_t> xrSubCtrlRequest(uint8_t op);
Result xrParseSubCtrl(const std::vector<uint8_t>& response);

std::vector<uint8_t> xrSubReadRequest(uint16_t maxBytes);
Result xrParseSubRead(const std::vector<uint8_t>& response, const std::vector<XrItem>& items,
                      XrSubReadReply& out);

}  // namespace cmsis_dap_helper
