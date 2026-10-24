#include "xr_dap_vendor.h"

#include <cstdio>

namespace cmsis_dap_helper {

namespace {

uint32_t le32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

uint64_t le(const uint8_t* p, size_t bytes) {
  uint64_t value = 0;
  for (size_t i = 0; i < bytes; ++i) value |= static_cast<uint64_t>(p[i]) << (8 * i);
  return value;
}

void put16(std::vector<uint8_t>& out, uint16_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xFF));
  out.push_back(static_cast<uint8_t>(value >> 8));
}

void put32(std::vector<uint8_t>& out, uint32_t value) {
  for (int shift = 0; shift < 32; shift += 8) out.push_back(static_cast<uint8_t>(value >> shift));
}

Result malformed(const std::string& what) {
  return Result::error(ErrorCodes::kMalformedResponse, "XR-DAP " + what);
}

// Checks the echoed command and overall status.
Result checkHeader(const std::vector<uint8_t>& response, uint8_t command) {
  if (response.empty() || response[0] != command) {
    return malformed("response does not echo command");
  }
  if (response.size() < 2) return malformed("response is too short");
  return xrStatusResult(command, response[1]);
}

}  // namespace

const char* xrStatusName(uint8_t status) {
  switch (status) {
    case 0x00: return "ok";
    case 0x01: return "invalid argument";
    case 0x02: return "not allowed in the current sampling state";
    case 0x03: return "insufficient probe resources";
    case 0x04: return "target not connected";
    default: return "unknown status";
  }
}

Result xrStatusResult(uint8_t command, uint8_t status) {
  if (status == 0) return Result::success();
  const char* code = status == 0x04 ? ErrorCodes::kInvalidState
                   : status == 0x02 ? ErrorCodes::kInvalidState
                   : status == 0x01 ? ErrorCodes::kDapInvalidRequest
                                    : ErrorCodes::kProtocolError;
  char text[96];
  std::snprintf(text, sizeof(text), "XR-DAP command 0x%02X failed with status 0x%02X (%s)",
                command, status, xrStatusName(status));
  return Result::error(code, text);
}

bool xrItemValid(const XrItem& item) {
  return (item.size == 1 || item.size == 2 || item.size == 4 || item.size == 8) &&
         item.derefs.size() <= kXrMaxDerefs && item.div > 0 && item.phase < item.div;
}

void xrAppendItem(std::vector<uint8_t>& out, const XrItem& item) {
  out.push_back(item.ap);
  put16(out, item.id);
  out.push_back(item.size);
  put32(out, item.base);
  out.push_back(static_cast<uint8_t>(item.derefs.size()));
  for (const int16_t offset : item.derefs) put16(out, static_cast<uint16_t>(offset));
  put16(out, static_cast<uint16_t>(item.finalOffset));
}

std::vector<uint8_t> xrInfoRequest() { return {kXrCmdInfo}; }

Result xrParseInfo(const std::vector<uint8_t>& response, XrInfo& out) {
  if (response.size() == 1 && response[0] == 0xFF) {
    return Result::error(ErrorCodes::kTransportNotSupported,
                         "probe does not implement the XR-DAP vendor extension");
  }
  const Result header = checkHeader(response, kXrCmdInfo);
  if (!header.ok) return header;
  if (response.size() < 26) return malformed("INFO response is shorter than 26 bytes");
  const uint8_t* p = response.data();
  out.version = p[2];
  out.features = le32(p + 3);
  out.maxItems = static_cast<uint16_t>(le(p + 7, 2));
  out.maxDepth = p[9];
  out.bufferBytes = le32(p + 10);
  out.probeNowUs = le(p + 14, 8);
  out.accessUs = le32(p + 22);
  return Result::success();
}

std::vector<uint8_t> xrReadRequest(const std::vector<XrItem>& items) {
  std::vector<uint8_t> out{kXrCmdRead, static_cast<uint8_t>(items.size())};
  for (const XrItem& item : items) xrAppendItem(out, item);
  return out;
}

Result xrParseRead(const std::vector<uint8_t>& response, const std::vector<XrItem>& items,
                   std::vector<XrReadValue>& out) {
  out.clear();
  const Result header = checkHeader(response, kXrCmdRead);
  if (!header.ok) return header;
  if (response.size() < 3 || response[2] != items.size()) return malformed("READ item count mismatch");
  size_t offset = 3;
  for (const XrItem& item : items) {
    if (offset + 3u + item.size > response.size()) return malformed("READ response is truncated");
    XrReadValue value;
    value.id = static_cast<uint16_t>(le(response.data() + offset, 2));
    value.status = response[offset + 2];
    value.bytes.assign(response.begin() + static_cast<std::ptrdiff_t>(offset + 3),
                       response.begin() + static_cast<std::ptrdiff_t>(offset + 3 + item.size));
    if (value.id != item.id) return malformed("READ item id mismatch");
    out.push_back(std::move(value));
    offset += 3u + item.size;
  }
  return Result::success();
}

std::vector<uint8_t> xrSubSetRequest(uint32_t periodUs, bool stopWhenFull,
                                     const std::vector<XrItem>& items) {
  std::vector<uint8_t> out{kXrCmdSubSet};
  put32(out, periodUs);
  out.push_back(stopWhenFull ? 1 : 0);
  put16(out, static_cast<uint16_t>(items.size()));
  for (const XrItem& item : items) {
    xrAppendItem(out, item);
    put16(out, item.div);
    put16(out, item.phase);
  }
  return out;
}

Result xrParseSubSet(const std::vector<uint8_t>& response, XrSubSetReply& out) {
  if (response.size() < 2 || response[0] != kXrCmdSubSet) return malformed("SUB_SET response is malformed");
  out.status = response[1];
  if (out.status != 0 && out.status != 0x03) return xrStatusResult(kXrCmdSubSet, out.status);
  if (response.size() < 8) {
    // A resource failure from older firmware may carry no estimate.
    if (out.status == 0x03) return Result::success();
    return malformed("SUB_SET response is shorter than 8 bytes");
  }
  out.maxFrameBytes = static_cast<uint16_t>(le(response.data() + 2, 2));
  out.estFrameUs = le32(response.data() + 4);
  return Result::success();
}

std::vector<uint8_t> xrSubCtrlRequest(uint8_t op) { return {kXrCmdSubCtrl, op}; }

Result xrParseSubCtrl(const std::vector<uint8_t>& response) {
  return checkHeader(response, kXrCmdSubCtrl);
}

std::vector<uint8_t> xrSubReadRequest(uint16_t maxBytes) {
  std::vector<uint8_t> out{kXrCmdSubRead};
  put16(out, maxBytes);
  return out;
}

Result xrParseSubRead(const std::vector<uint8_t>& response, const std::vector<XrItem>& items,
                      XrSubReadReply& out) {
  out = XrSubReadReply{};
  const Result header = checkHeader(response, kXrCmdSubRead);
  if (!header.ok) return header;
  if (response.size() < kXrSubReadHeader) return malformed("SUB_READ header is truncated");
  const uint8_t* p = response.data();
  out.probeNowUs = le(p + 2, 8);
  out.pendingBytes = le32(p + 10);
  out.droppedFrames = le32(p + 14);
  out.skippedTicks = le32(p + 18);
  const size_t frameCount = static_cast<size_t>(le(p + 22, 2));
  size_t offset = kXrSubReadHeader;
  std::vector<size_t> due;
  for (size_t f = 0; f < frameCount; ++f) {
    if (offset + 10 > response.size()) return malformed("SUB_READ frame header is truncated");
    XrFrame frame;
    frame.tick = le32(p + offset);
    frame.timestampUs = le(p + offset + 4, 6);
    offset += 10;
    // The due items follow from the tick and each item's div/phase.
    due.clear();
    for (size_t i = 0; i < items.size(); ++i) {
      if ((static_cast<uint64_t>(frame.tick) + items[i].phase) % items[i].div == 0) due.push_back(i);
    }
    const size_t bitmapBytes = (due.size() + 7) / 8;
    if (offset + bitmapBytes > response.size()) return malformed("SUB_READ frame bitmap is truncated");
    const uint8_t* bitmap = p + offset;
    offset += bitmapBytes;
    for (size_t k = 0; k < due.size(); ++k) {
      const XrItem& item = items[due[k]];
      if (offset + item.size > response.size()) return malformed("SUB_READ frame values are truncated");
      XrFrameValue value;
      value.item = due[k];
      value.ok = (bitmap[k / 8] & (1u << (k % 8))) == 0;
      value.bytes.assign(p + offset, p + offset + item.size);
      offset += item.size;
      frame.values.push_back(std::move(value));
    }
    out.frames.push_back(std::move(frame));
  }
  return Result::success();
}

}  // namespace cmsis_dap_helper
