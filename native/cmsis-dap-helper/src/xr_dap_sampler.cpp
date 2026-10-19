#include "xr_dap_sampler.h"

#include <algorithm>
#include <cstdio>
#include <iterator>

namespace cmsis_dap_helper {

namespace {

constexpr size_t kSuspendDrainRounds = 32;
// Upper bound on frames held while the caller does not read.
constexpr size_t kMaxPendingFrames = 65536;

uint64_t microsBetween(std::chrono::steady_clock::time_point from,
                       std::chrono::steady_clock::time_point to) {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(to - from).count());
}

}  // namespace

XrSamplingRoute xrSamplingRoute(const std::string& method) {
  if (method == "hello" || method == "enumDevices" || method == "getInfo" || method == "xrInfo" ||
      method == "xrSamplingStart" || method == "xrSamplingRead" || method == "xrSamplingStop") {
    return XrSamplingRoute::Direct;
  }
  if (method == "readMemory" || method == "readMemoryBatch" || method == "getState") {
    return XrSamplingRoute::VendorRead;
  }
  if (method == "shutdown" || method == "open" || method == "close" || method == "connect" ||
      method == "disconnect") {
    return XrSamplingRoute::Stop;
  }
  return XrSamplingRoute::Suspend;
}

bool xrFitsVendorRead(uint32_t address, uint32_t size) {
  if (size != 1 && size != 2 && size != 4 && size != 8) return false;
  return address % (size == 8 ? 4u : size) == 0;
}

Result XrDapSampler::control(CmsisDapProtocol& protocol, uint8_t op,
                             std::chrono::milliseconds timeout) {
  std::vector<uint8_t> response;
  const Result result = protocol.vendorExchange(xrSubCtrlRequest(op), response, timeout);
  return result.ok ? xrParseSubCtrl(response) : result;
}

Result XrDapSampler::queryInfo(CmsisDapProtocol& protocol, XrInfo& info,
                               std::chrono::milliseconds timeout) {
  std::vector<uint8_t> response;
  const Result result = protocol.vendorExchange(xrInfoRequest(), response, timeout);
  return result.ok ? xrParseInfo(response, info) : result;
}

Result XrDapSampler::start(CmsisDapProtocol& protocol, uint32_t periodUs,
                           std::vector<XrItem> items, XrSubSetReply& reply,
                           std::chrono::milliseconds timeout) {
  if (active_) {
    const Result stopped = stop(protocol, timeout);
    if (!stopped.ok) return stopped;
  }
  if (items.empty() || items.size() > 32 || periodUs == 0 ||
      !std::all_of(items.begin(), items.end(), xrItemValid)) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "probe sampling needs 1..32 valid items and a non-zero period");
  }
  auto subscribe = [&](uint32_t period) {
    std::vector<uint8_t> response;
    const Result result =
        protocol.vendorExchange(xrSubSetRequest(period, false, items), response, timeout);
    return result.ok ? xrParseSubSet(response, reply) : result;
  };
  Result result = subscribe(periodUs);
  if (result.ok && reply.status == 0x03 && reply.estFrameUs > 0) {
    periodUs = std::max(periodUs, reply.estFrameUs + reply.estFrameUs / 4);
    result = subscribe(periodUs);
  }
  if (!result.ok) return result;
  if (reply.status != 0) return xrStatusResult(kXrCmdSubSet, reply.status);
  result = control(protocol, kXrSubStart, timeout);
  if (!result.ok) return result;

  items_ = std::move(items);
  periodUs_ = periodUs;
  pending_.clear();
  stats_ = Stats{};
  runDropped_ = runSkipped_ = 0;
  restartError_ = Result::success();
  active_ = running_ = true;
  return Result::success();
}

Result XrDapSampler::drain(CmsisDapProtocol& protocol, size_t maxRounds,
                           std::chrono::milliseconds timeout, ReadResult* timing) {
  std::vector<uint8_t> response;
  const uint16_t maxBytes = static_cast<uint16_t>(kXrPacketSize - kXrSubReadHeader);
  for (size_t round = 0; round < maxRounds; ++round) {
    const auto sent = std::chrono::steady_clock::now();
    Result result = protocol.vendorExchange(xrSubReadRequest(maxBytes), response, timeout);
    const auto received = std::chrono::steady_clock::now();
    if (!result.ok) return result;
    XrSubReadReply reply;
    result = xrParseSubRead(response, items_, reply);
    if (!result.ok) return result;

    stats_.droppedFrames += reply.droppedFrames - std::min(reply.droppedFrames, runDropped_);
    stats_.skippedTicks += reply.skippedTicks - std::min(reply.skippedTicks, runSkipped_);
    runDropped_ = reply.droppedFrames;
    runSkipped_ = reply.skippedTicks;
    if (timing) {
      if (round == 0) {
        timing->probeNowUs = reply.probeNowUs;
        // Temporarily the half round trip; read() turns it into the age.
        timing->probeNowAgeUs = microsBetween(sent, received) / 2;
      }
      timing->pendingBytes = reply.pendingBytes;
    }
    std::move(reply.frames.begin(), reply.frames.end(), std::back_inserter(pending_));
    while (pending_.size() > kMaxPendingFrames) pending_.pop_front();
    if (reply.pendingBytes == 0) break;
  }
  return Result::success();
}

Result XrDapSampler::read(CmsisDapProtocol& protocol, ReadResult& out, size_t maxRounds,
                          std::chrono::milliseconds timeout) {
  out = ReadResult{};
  if (!restartError_.ok) return std::exchange(restartError_, Result::success());
  if (!active_) return Result::error(ErrorCodes::kInvalidState, "probe sampling is not running");
  const auto started = std::chrono::steady_clock::now();
  const Result result = drain(protocol, std::max<size_t>(maxRounds, 1), timeout, &out);
  if (!result.ok) return result;
  // The pairing point is the midpoint of the first round trip, which began
  // about when read() started: its age is the elapsed time minus half a trip.
  out.probeNowAgeUs = microsBetween(started, std::chrono::steady_clock::now()) - out.probeNowAgeUs;
  out.frames.assign(std::make_move_iterator(pending_.begin()), std::make_move_iterator(pending_.end()));
  pending_.clear();
  return Result::success();
}

Result XrDapSampler::stop(CmsisDapProtocol& protocol, std::chrono::milliseconds timeout) {
  if (!active_ && !running_) return Result::success();
  const Result result = control(protocol, kXrSubStop, timeout);
  reset();
  return result;
}

Result XrDapSampler::suspend(CmsisDapProtocol& protocol, std::chrono::milliseconds timeout) {
  if (!running_) return Result::success();
  const Result result = control(protocol, kXrSubStop, timeout);
  running_ = false;
  if (!result.ok) {
    active_ = false;
    return result;
  }
  ++stats_.suspends;
  return drain(protocol, kSuspendDrainRounds, timeout, nullptr);
}

void XrDapSampler::resume(CmsisDapProtocol& protocol, std::chrono::milliseconds timeout) {
  if (!active_ || running_) return;
  const Result result = control(protocol, kXrSubStart, timeout);
  if (!result.ok) {
    // E.g. the target link went away (status 0x04).
    active_ = false;
    restartError_ = result;
    return;
  }
  runDropped_ = runSkipped_ = 0;
  running_ = true;
}

void XrDapSampler::reset() {
  active_ = running_ = false;
  items_.clear();
  pending_.clear();
  periodUs_ = 0;
}

Result XrDapSampler::readScalars(CmsisDapProtocol& protocol,
                                 const std::vector<std::pair<uint32_t, uint32_t>>& reads,
                                 std::vector<std::vector<uint8_t>>& values,
                                 std::chrono::milliseconds timeout) {
  values.clear();
  std::vector<XrItem> items(reads.size());
  for (size_t i = 0; i < reads.size(); ++i) {
    if (!xrFitsVendorRead(reads[i].first, reads[i].second)) {
      return Result::error(ErrorCodes::kDapInvalidRequest, "read does not fit vendor READ");
    }
    items[i].id = static_cast<uint16_t>(i);
    items[i].size = static_cast<uint8_t>(reads[i].second);
    items[i].base = reads[i].first;
  }
  std::vector<uint8_t> response;
  std::vector<XrReadValue> chunkValues;
  for (size_t begin = 0; begin < items.size();) {
    // As many items as fit one request (32) and one response packet.
    size_t end = begin;
    size_t responseBytes = 3;
    while (end < items.size() && end - begin < 32 &&
           responseBytes + 3u + items[end].size <= kXrPacketSize) {
      responseBytes += 3u + items[end].size;
      ++end;
    }
    const std::vector<XrItem> chunk(items.begin() + static_cast<std::ptrdiff_t>(begin),
                                    items.begin() + static_cast<std::ptrdiff_t>(end));
    Result result = protocol.vendorExchange(xrReadRequest(chunk), response, timeout);
    if (result.ok) result = xrParseRead(response, chunk, chunkValues);
    if (!result.ok) return result;
    for (XrReadValue& value : chunkValues) {
      if (value.status != 0) {
        char text[96];
        std::snprintf(text, sizeof(text), "XR-DAP READ of 0x%08X failed with item status 0x%02X",
                      items[value.id].base, value.status);
        return Result::error(ErrorCodes::kDapAckFault, text);
      }
      values.push_back(std::move(value.bytes));
    }
    begin = end;
  }
  ++stats_.vendorReads;
  return Result::success();
}

}  // namespace cmsis_dap_helper
