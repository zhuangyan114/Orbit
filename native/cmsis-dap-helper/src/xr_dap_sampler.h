#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <string>
#include <utility>
#include <vector>

#include "cmsis_dap_protocol.h"
#include "xr_dap_vendor.h"

namespace cmsis_dap_helper {

// How dispatch() treats a helper request while the probe samples. The probe
// answers every ordinary DAP command with 0xFF until sampling stops.
enum class XrSamplingRoute {
  Direct,      // answered by the probe while sampling (DAP_Info, vendor commands)
  VendorRead,  // scalar memory read or core state; try vendor READ first
  Suspend,     // stop sampling, run the request, restart sampling
  Stop,        // the request ends or replaces the target link
};

XrSamplingRoute xrSamplingRoute(const std::string& method);

// A memory read {address, size} fits vendor READ when size is 1, 2, 4 or 8
// and the address is aligned (4-byte alignment for 8-byte reads).
bool xrFitsVendorRead(uint32_t address, uint32_t size);

// Owns one XR-DAP probe-side sampling subscription on the selected CMSIS-DAP
// owner. Frames still buffered on the probe when sampling is suspended are
// kept and delivered by the next read().
class XrDapSampler {
 public:
  struct Stats {
    uint64_t droppedFrames = 0;  // probe ring overflow, summed across restarts
    uint64_t skippedTicks = 0;   // SWD slower than the period, summed across restarts
    uint64_t suspends = 0;       // requests that paused sampling
    uint64_t vendorReads = 0;    // requests served through vendor READ
  };

  struct ReadResult {
    std::vector<XrFrame> frames;
    // Probe clock at the midpoint of the first SUB_READ round trip, and the
    // microseconds from that midpoint to the end of read().
    uint64_t probeNowUs = 0;
    uint64_t probeNowAgeUs = 0;
    uint32_t pendingBytes = 0;
  };

  // A subscription is configured and was not stopped (it may be suspended).
  bool active() const { return active_; }
  // The probe is sampling right now.
  bool running() const { return running_; }
  uint32_t periodUs() const { return periodUs_; }
  const Stats& stats() const { return stats_; }

  Result queryInfo(CmsisDapProtocol& protocol, XrInfo& info, std::chrono::milliseconds timeout);

  // Configures and starts sampling. When the probe estimates the period is too
  // short it is retried once with the estimate plus 25 %; periodUs() reports
  // the period in use and `reply` the probe's estimate.
  Result start(CmsisDapProtocol& protocol, uint32_t periodUs, std::vector<XrItem> items,
               XrSubSetReply& reply, std::chrono::milliseconds timeout);

  // Returns frames held since the last read plus what the probe buffered, using
  // at most `maxRounds` SUB_READ requests. Reports once a failed restart.
  Result read(CmsisDapProtocol& protocol, ReadResult& out, size_t maxRounds,
              std::chrono::milliseconds timeout);

  Result stop(CmsisDapProtocol& protocol, std::chrono::milliseconds timeout);
  Result suspend(CmsisDapProtocol& protocol, std::chrono::milliseconds timeout);
  // A failed restart ends the subscription; read() then returns that error.
  void resume(CmsisDapProtocol& protocol, std::chrono::milliseconds timeout);

  // Forgets the subscription without talking to the probe (device closed).
  void reset();

  // Vendor READ of plain locations; every read must satisfy xrFitsVendorRead.
  // Fails on the first item the probe could not read.
  Result readScalars(CmsisDapProtocol& protocol,
                     const std::vector<std::pair<uint32_t, uint32_t>>& reads,
                     std::vector<std::vector<uint8_t>>& values,
                     std::chrono::milliseconds timeout);

 private:
  Result control(CmsisDapProtocol& protocol, uint8_t op, std::chrono::milliseconds timeout);
  Result drain(CmsisDapProtocol& protocol, size_t maxRounds, std::chrono::milliseconds timeout,
               ReadResult* timing);

  bool active_ = false;
  bool running_ = false;
  uint32_t periodUs_ = 0;
  std::vector<XrItem> items_;
  std::deque<XrFrame> pending_;
  Result restartError_ = Result::success();
  Stats stats_{};
  // Probe counters of the current run; they restart from zero on SUB_CTRL start.
  uint32_t runDropped_ = 0;
  uint32_t runSkipped_ = 0;
};

}  // namespace cmsis_dap_helper
