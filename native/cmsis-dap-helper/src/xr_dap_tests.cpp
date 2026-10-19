// Unit tests for the XR-DAP vendor encoding, the CMSIS-DAP TCP transport and
// the probe sampling state machine. Byte examples come from the XR-DAP
// protocol document (XRDAP-ESP docs/protocol.md, section 3).
#include <winsock2.h>

#include <chrono>
#include <cstring>
#include <deque>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "cmsis_dap_protocol.h"
#include "cmsis_dap_tcp_transport.h"
#include "xr_dap_sampler.h"
#include "xr_dap_vendor.h"

namespace {

using namespace cmsis_dap_helper;
using Bytes = std::vector<uint8_t>;

constexpr std::chrono::milliseconds kTimeout(100);

int failures = 0;

void expect(bool ok, const char* name) {
  if (!ok) {
    ++failures;
    std::cerr << "FAIL " << name << "\n";
  }
}

XrItem item(uint16_t id, uint8_t size, uint32_t base, uint16_t div = 1, uint16_t phase = 0) {
  XrItem out;
  out.id = id;
  out.size = size;
  out.base = base;
  out.div = div;
  out.phase = phase;
  return out;
}

Bytes subReadReply(uint32_t dropped, uint32_t skipped) {
  Bytes reply(kXrSubReadHeader, 0);
  reply[0] = kXrCmdSubRead;
  for (int i = 0; i < 4; ++i) {
    reply[14 + i] = static_cast<uint8_t>(dropped >> (8 * i));
    reply[18 + i] = static_cast<uint8_t>(skipped >> (8 * i));
  }
  return reply;
}

// Replays queued responses and records requests.
class ScriptedWire final : public CmsisDapTransport {
 public:
  std::deque<Bytes> responses;
  std::vector<Bytes> requests;

  std::string transportName() const override { return "scripted"; }
  Result enumerate(const DeviceSelector&, std::vector<DeviceDescriptor>& out) override {
    out.clear();
    return Result::success();
  }
  Result open(const DeviceDescriptor&) override { return Result::success(); }
  Result close() override { return Result::success(); }
  bool isOpen() const override { return true; }
  Result writePacket(const uint8_t* data, size_t length, std::chrono::milliseconds) override {
    requests.emplace_back(data, data + length);
    return Result::success();
  }
  Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                    std::chrono::milliseconds) override {
    if (responses.empty()) return Result::error(ErrorCodes::kReadTimeout, "no scripted response");
    const Bytes response = responses.front();
    responses.pop_front();
    if (response.size() > capacity) return Result::error(ErrorCodes::kMalformedResponse, "too long");
    std::memcpy(data, response.data(), response.size());
    length = response.size();
    return Result::success();
  }
  size_t payloadCapacity() const override { return kXrPacketSize; }
  Result drainInput(std::chrono::milliseconds) override { return Result::success(); }
  bool deviceLost() const override { return false; }
  TransportIoCounters ioCounters() const override { return {}; }
};

void testVendorEncoding() {
  XrItem chained = item(1, 4, 0x20000000);
  chained.derefs = {8};
  chained.finalOffset = 4;
  expect(xrReadRequest({chained}) ==
             Bytes{0x81, 0x01, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x20, 0x01, 0x08, 0x00, 0x04, 0x00},
         "read-request-matches-protocol-example");
  std::vector<XrReadValue> values;
  expect(xrParseRead({0x81, 0x00, 0x01, 0x01, 0x00, 0x00, 0x78, 0x56, 0x34, 0x12}, {chained}, values).ok &&
             values.size() == 1 && values[0].status == 0 && values[0].bytes == Bytes{0x78, 0x56, 0x34, 0x12},
         "read-response-decodes-value");

  const XrItem fast = item(0x10, 4, 0x20000100);
  const XrItem slow = item(0x11, 2, 0x20000104, 10, 3);
  expect(xrSubSetRequest(1000, false, {fast, slow}) ==
             Bytes{0x83, 0xE8, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00,
                   0x00, 0x10, 0x00, 0x04, 0x00, 0x01, 0x00, 0x20, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
                   0x00, 0x11, 0x00, 0x02, 0x04, 0x01, 0x00, 0x20, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x03, 0x00},
         "sub-set-request-matches-protocol-example");
  XrSubSetReply reply;
  expect(xrParseSubSet({0x83, 0x03, 0x11, 0x00, 0x78, 0x00, 0x00, 0x00}, reply).ok && reply.status == 0x03 &&
             reply.maxFrameBytes == 17 && reply.estFrameUs == 120,
         "sub-set-resource-reply-keeps-estimate");

  // k=6 has only the fast item due, k=7 has both.
  const Bytes subRead = {
      0x85, 0x00, 0x80, 0x61, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00,
      0x06, 0x00, 0x00, 0x00, 0xB0, 0x59, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00,
      0x07, 0x00, 0x00, 0x00, 0x98, 0x5D, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x34, 0x12};
  XrSubReadReply frames;
  expect(xrParseSubRead(subRead, {fast, slow}, frames).ok && frames.probeNowUs == 1008000 &&
             frames.frames.size() == 2 && frames.frames[0].tick == 6 &&
             frames.frames[0].timestampUs == 1006000 && frames.frames[0].values.size() == 1 &&
             frames.frames[1].values.size() == 2 && frames.frames[1].values[1].item == 1 &&
             frames.frames[1].values[1].ok && frames.frames[1].values[1].bytes == Bytes{0x34, 0x12},
         "sub-read-decodes-due-items-per-tick");

  XrInfo info;
  expect(xrParseInfo({0xFF}, info).errorCode == ErrorCodes::kTransportNotSupported,
         "info-ff-means-no-extension");
}

void testTcpFraming() {
  expect(tcpFrameHeader(1, 1) == Bytes{'D', 'A', 'P', 0, 1, 0, 1, 0}, "tcp-frame-header-layout");
  const uint8_t response[8] = {'D', 'A', 'P', 0, 0x10, 0x02, 2, 0};
  expect(parseTcpFrameHeader(response, 2) == 0x210 && parseTcpFrameHeader(response, 1) == -1,
         "tcp-frame-header-checks-type");
  TcpEndpoint endpoint;
  expect(parseTcpEndpoint("192.168.0.108", endpoint) && endpoint.port == kDefaultTcpPort &&
             parseTcpEndpoint("probe.local:4441", endpoint) && endpoint.host == "probe.local" &&
             endpoint.port == 4441 && parseTcpEndpoint("[::1]:3000", endpoint) && endpoint.host == "::1" &&
             endpoint.port == 3000 && parseTcpEndpoint("fe80::1", endpoint) &&
             endpoint.port == kDefaultTcpPort && !parseTcpEndpoint("", endpoint) &&
             !parseTcpEndpoint("host:0", endpoint) && !parseTcpEndpoint("host:x", endpoint),
         "tcp-endpoint-parsing");
}

// A late response to a timed-out request is skipped, and a read with nothing
// outstanding (the protocol layer's retry) does not shift later pairing.
void testTcpResponsePairing() {
  WSADATA wsa{};
  WSAStartup(MAKEWORD(2, 2), &wsa);
  SOCKET listener = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int addressLength = sizeof(address);
  ::bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address));
  ::listen(listener, 1);
  getsockname(listener, reinterpret_cast<sockaddr*>(&address), &addressLength);

  std::thread server([listener] {
    SOCKET peer = ::accept(listener, nullptr, nullptr);
    auto awaitRequest = [peer] {
      uint8_t buffer[kTcpHeaderLength + 1];
      for (int got = 0; got < static_cast<int>(sizeof(buffer));) {
        const int rc = ::recv(peer, reinterpret_cast<char*>(buffer + got), sizeof(buffer) - got, 0);
        if (rc <= 0) return;
        got += rc;
      }
    };
    auto respond = [peer](uint8_t command) {
      Bytes frame = tcpFrameHeader(1, 2);
      frame.push_back(command);
      ::send(peer, reinterpret_cast<const char*>(frame.data()), static_cast<int>(frame.size()), 0);
    };
    awaitRequest();
    std::this_thread::sleep_for(std::chrono::milliseconds(150));  // the client gives up first
    respond(0x01);
    awaitRequest();
    respond(0x02);
    awaitRequest();
    respond(0x03);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    closesocket(peer);
  });

  CmsisDapTcpTransport transport;
  DeviceDescriptor device;
  device.path = "127.0.0.1:" + std::to_string(ntohs(address.sin_port));
  const bool opened = transport.open(device).ok;
  const uint8_t request[1] = {0x00};
  uint8_t response[16];
  size_t length = 0;
  auto readOne = [&](int ms) {
    return transport.readPacket(response, sizeof(response), length, std::chrono::milliseconds(ms));
  };
  transport.writePacket(request, 1, kTimeout);
  const Result timedOut = readOne(50);
  transport.writePacket(request, 1, kTimeout);
  const bool second = readOne(1000).ok && length == 1 && response[0] == 0x02;
  const Result retry = readOne(30);
  transport.writePacket(request, 1, kTimeout);
  const bool third = readOne(1000).ok && response[0] == 0x03;
  expect(opened && timedOut.errorCode == ErrorCodes::kReadTimeout && second &&
             retry.errorCode == ErrorCodes::kReadTimeout && third && !transport.deviceLost(),
         "tcp-pairs-responses-with-requests");
  server.join();
  transport.close();
  closesocket(listener);
  WSACleanup();
}

void testSamplingRoutes() {
  expect(xrSamplingRoute("xrSamplingRead") == XrSamplingRoute::Direct &&
             xrSamplingRoute("getInfo") == XrSamplingRoute::Direct &&
             xrSamplingRoute("readMemoryBatch") == XrSamplingRoute::VendorRead &&
             xrSamplingRoute("getState") == XrSamplingRoute::VendorRead &&
             xrSamplingRoute("halt") == XrSamplingRoute::Suspend &&
             xrSamplingRoute("writeMemory") == XrSamplingRoute::Suspend &&
             xrSamplingRoute("disconnect") == XrSamplingRoute::Stop,
         "sampling-routes");
  expect(xrFitsVendorRead(0x20000004, 4) && xrFitsVendorRead(0x20000004, 8) &&
             xrFitsVendorRead(0x20000003, 1) && !xrFitsVendorRead(0x20000002, 4) &&
             !xrFitsVendorRead(0x20000000, 3) && !xrFitsVendorRead(0x20000000, 16),
         "vendor-read-fit");
}

void testSamplerLifecycle() {
  ScriptedWire wire;
  CmsisDapProtocol protocol(&wire);
  XrDapSampler sampler;
  XrSubSetReply reply;

  // The probe rejects 200 µs and estimates 400 µs: the retry uses 500 µs.
  wire.responses = {{0x83, 0x03, 0x0E, 0x00, 0x90, 0x01, 0x00, 0x00},
                    {0x83, 0x00, 0x0E, 0x00, 0x90, 0x01, 0x00, 0x00},
                    {0x84, 0x00}};
  expect(sampler.start(protocol, 200, {item(0, 4, 0x20000000)}, reply, kTimeout).ok &&
             sampler.running() && sampler.periodUs() == 500,
         "start-lengthens-a-period-the-probe-cannot-keep");

  // Counters restart on every resume; the totals add the runs up.
  wire.responses = {subReadReply(3, 5)};
  XrDapSampler::ReadResult read;
  expect(sampler.read(protocol, read, 1, kTimeout).ok, "read");
  wire.responses = {{0x84, 0x00}, subReadReply(4, 5), {0x84, 0x00}};
  expect(sampler.suspend(protocol, kTimeout).ok && !sampler.running(), "suspend");
  sampler.resume(protocol, kTimeout);
  wire.responses = {subReadReply(2, 1)};
  expect(sampler.read(protocol, read, 1, kTimeout).ok && sampler.stats().droppedFrames == 6 &&
             sampler.stats().skippedTicks == 6 && sampler.stats().suspends == 1,
         "counters-accumulate-across-restarts");

  // A failed restart ends the subscription and is reported once by read().
  wire.responses = {{0x84, 0x00}, subReadReply(0, 0), {0x84, 0x04}};
  sampler.suspend(protocol, kTimeout);
  sampler.resume(protocol, kTimeout);
  const Result failedRestart = sampler.read(protocol, read, 1, kTimeout);
  expect(!sampler.active() && !failedRestart.ok && failedRestart.errorCode == ErrorCodes::kInvalidState &&
             sampler.read(protocol, read, 1, kTimeout).message == "probe sampling is not running",
         "failed-restart-is-reported-once");
}

void testReadScalarsChunking() {
  ScriptedWire wire;
  CmsisDapProtocol protocol(&wire);
  XrDapSampler sampler;
  std::vector<std::pair<uint32_t, uint32_t>> reads;
  for (uint32_t i = 0; i < 40; ++i) reads.push_back({0x20000000 + 4 * i, 4});
  auto readReply = [](size_t first, size_t count) {
    Bytes out{kXrCmdRead, 0x00, static_cast<uint8_t>(count)};
    for (size_t i = first; i < first + count; ++i) {
      out.insert(out.end(), {static_cast<uint8_t>(i), 0x00, 0x00, static_cast<uint8_t>(i), 0, 0, 0});
    }
    return out;
  };
  wire.responses = {readReply(0, 32), readReply(32, 8)};
  std::vector<Bytes> values;
  expect(sampler.readScalars(protocol, reads, values, kTimeout).ok && wire.requests.size() == 2 &&
             wire.requests[0][1] == 32 && wire.requests[1][1] == 8 && values.size() == 40 &&
             values[39][0] == 39,
         "read-scalars-splits-at-32-items");
}

}  // namespace

int main() {
  testVendorEncoding();
  testTcpFraming();
  testTcpResponsePairing();
  testSamplingRoutes();
  testSamplerLifecycle();
  testReadScalarsChunking();
  if (failures == 0) {
    std::cout << "xr-dap-tests: PASS\n";
    return 0;
  }
  std::cerr << "xr-dap-tests: " << failures << " failure(s)\n";
  return 1;
}
