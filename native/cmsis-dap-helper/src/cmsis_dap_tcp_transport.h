#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

// CMSIS-DAP over TCP, using the framing of OpenOCD's cmsis-dap "tcp" backend:
//
//   offset 0  4  signature "DAP\0"
//   offset 4  2  payload length, little endian
//   offset 6  1  packet type: 1 request, 2 response
//   offset 7  1  reserved, 0
//   offset 8  .. one CMSIS-DAP command or response packet
//
// Each request yields exactly one response, in order. The device is selected
// by DeviceSelector::path = "host[:port]" (default port kDefaultTcpPort); an
// IPv6 literal with a port is written "[addr]:port".
//
// Responses are paired with requests by count: a request whose read timed
// out before any byte arrived stays outstanding, and its late response is
// skipped when the next request's response is read. A read with no request
// outstanding (a protocol-layer retry) returns whatever frame arrives. A
// timeout or framing error in the middle of a frame desynchronizes the
// stream, so the transport is marked lost.
constexpr uint16_t kDefaultTcpPort = 3241;
constexpr size_t kTcpHeaderLength = 8;
constexpr size_t kTcpMaxPacket = 1024;

struct TcpEndpoint {
  std::string host;
  uint16_t port = kDefaultTcpPort;
};

// Parses "host", "host:port", "[v6]" or "[v6]:port". Returns false on an
// empty host or an invalid port.
bool parseTcpEndpoint(const std::string& text, TcpEndpoint& out);

std::vector<uint8_t> tcpFrameHeader(size_t payloadLength, uint8_t type);

// Returns the payload length, or -1 when the signature or type is wrong.
int parseTcpFrameHeader(const uint8_t* header, uint8_t expectedType);

class CmsisDapTcpTransport final : public CmsisDapTransport {
 public:
  CmsisDapTcpTransport();
  ~CmsisDapTcpTransport() override;

  CmsisDapTcpTransport(const CmsisDapTcpTransport&) = delete;
  CmsisDapTcpTransport& operator=(const CmsisDapTcpTransport&) = delete;

  std::string transportName() const override { return "tcp"; }
  // Does not connect. Requires selector.path; returns one descriptor for it.
  Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) override;
  Result open(const DeviceDescriptor& device) override;
  Result close() override;
  bool isOpen() const override { return socket_ != INVALID_SOCKET; }
  Result writePacket(const uint8_t* data, size_t length,
                     std::chrono::milliseconds timeout) override;
  Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                    std::chrono::milliseconds timeout) override;
  size_t payloadCapacity() const override { return kTcpMaxPacket; }
  Result drainInput(std::chrono::milliseconds timeout) override;
  bool deviceLost() const override { return lost_; }
  TransportIoCounters ioCounters() const override { return counters_; }

 private:
  enum class RecvStatus { Ok, Timeout, Closed, Error };
  RecvStatus recvExact(uint8_t* data, size_t length, size_t& received,
                       std::chrono::steady_clock::time_point deadline);
  Result readFrame(std::vector<uint8_t>& payload, std::chrono::milliseconds timeout);
  Result markLost(const char* code, const std::string& message);

  bool winsockReady_ = false;
  SOCKET socket_ = INVALID_SOCKET;
  std::string peer_;
  // Requests sent whose response has not been read yet.
  uint32_t outstanding_ = 0;
  bool lost_ = false;
  TransportIoCounters counters_{};
};

}  // namespace cmsis_dap_helper
