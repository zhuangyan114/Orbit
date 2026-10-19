#include "cmsis_dap_tcp_transport.h"

#include <ws2tcpip.h>

#include <algorithm>
#include <cstring>

namespace cmsis_dap_helper {

namespace {

constexpr uint8_t kTypeRequest = 1;
constexpr uint8_t kTypeResponse = 2;
constexpr char kSignature[4] = {'D', 'A', 'P', '\0'};
constexpr std::chrono::milliseconds kConnectTimeout(3000);

int remainingMs(std::chrono::steady_clock::time_point deadline) {
  const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
      deadline - std::chrono::steady_clock::now()).count();
  return left <= 0 ? 0 : static_cast<int>(std::min<long long>(left, 0x7FFFFFFF));
}

std::string socketError(const char* what) {
  return std::string(what) + " failed (WSA error " + std::to_string(WSAGetLastError()) + ")";
}

// Waits until the socket is readable (read=true) or writable. Returns 1 when
// ready, 0 on timeout, -1 on error.
int waitSocket(SOCKET socket, bool read, int timeoutMs) {
  WSAPOLLFD fd{};
  fd.fd = socket;
  fd.events = read ? POLLRDNORM : POLLWRNORM;
  const int rc = WSAPoll(&fd, 1, timeoutMs);
  if (rc < 0) return -1;
  if (rc == 0) return 0;
  if (fd.revents & (POLLERR | POLLNVAL)) return -1;
  return 1;
}

}  // namespace

bool parseTcpEndpoint(const std::string& text, TcpEndpoint& out) {
  std::string host;
  std::string port;
  if (!text.empty() && text.front() == '[') {
    const size_t close = text.find(']');
    if (close == std::string::npos) return false;
    host = text.substr(1, close - 1);
    if (close + 1 < text.size()) {
      if (text[close + 1] != ':') return false;
      port = text.substr(close + 2);
    }
  } else {
    const size_t colon = text.find(':');
    if (colon != std::string::npos && text.find(':', colon + 1) == std::string::npos) {
      host = text.substr(0, colon);
      port = text.substr(colon + 1);
    } else {
      host = text;  // no port, or a bare IPv6 literal
    }
  }
  if (host.empty()) return false;
  out.host = host;
  out.port = kDefaultTcpPort;
  if (!port.empty()) {
    if (port.size() > 5 || !std::all_of(port.begin(), port.end(), ::isdigit)) return false;
    const unsigned long value = std::stoul(port);
    if (value == 0 || value > 65535) return false;
    out.port = static_cast<uint16_t>(value);
  }
  return true;
}

std::vector<uint8_t> tcpFrameHeader(size_t payloadLength, uint8_t type) {
  return {static_cast<uint8_t>(kSignature[0]), static_cast<uint8_t>(kSignature[1]),
          static_cast<uint8_t>(kSignature[2]), static_cast<uint8_t>(kSignature[3]),
          static_cast<uint8_t>(payloadLength & 0xFF),
          static_cast<uint8_t>((payloadLength >> 8) & 0xFF), type, 0};
}

int parseTcpFrameHeader(const uint8_t* header, uint8_t expectedType) {
  if (std::memcmp(header, kSignature, sizeof(kSignature)) != 0 || header[6] != expectedType) {
    return -1;
  }
  return header[4] | (header[5] << 8);
}

CmsisDapTcpTransport::CmsisDapTcpTransport() {
  WSADATA data{};
  winsockReady_ = WSAStartup(MAKEWORD(2, 2), &data) == 0;
}

CmsisDapTcpTransport::~CmsisDapTcpTransport() {
  close();
  if (winsockReady_) WSACleanup();
}

Result CmsisDapTcpTransport::enumerate(const DeviceSelector& selector,
                                       std::vector<DeviceDescriptor>& out) {
  out.clear();
  if (selector.path.empty()) {
    return Result::error(ErrorCodes::kDeviceNotFound,
                         "the tcp transport needs the probe address as cmsisDapPath "
                         "(host or host:port)");
  }
  TcpEndpoint endpoint;
  if (!parseTcpEndpoint(selector.path, endpoint)) {
    return Result::error(ErrorCodes::kDeviceNotFound,
                         "invalid tcp probe address '" + selector.path + "'");
  }
  DeviceDescriptor device;
  device.path = selector.path;
  device.product = "CMSIS-DAP TCP " + endpoint.host + ":" + std::to_string(endpoint.port);
  device.transport = "tcp";
  device.inputReportLength = static_cast<uint16_t>(kTcpMaxPacket);
  device.outputReportLength = static_cast<uint16_t>(kTcpMaxPacket);
  out.push_back(device);
  return Result::success();
}

Result CmsisDapTcpTransport::open(const DeviceDescriptor& device) {
  if (isOpen()) return Result::error(ErrorCodes::kInvalidState, "tcp transport already open");
  if (!winsockReady_) return Result::error(ErrorCodes::kDeviceOpenFailed, "WSAStartup failed");
  TcpEndpoint endpoint;
  if (!parseTcpEndpoint(device.path, endpoint)) {
    return Result::error(ErrorCodes::kDeviceOpenFailed, "invalid tcp probe address '" + device.path + "'");
  }
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;
  addrinfo* addresses = nullptr;
  const std::string port = std::to_string(endpoint.port);
  if (getaddrinfo(endpoint.host.c_str(), port.c_str(), &hints, &addresses) != 0 || !addresses) {
    return Result::error(ErrorCodes::kDeviceNotFound, "cannot resolve tcp probe host '" + endpoint.host + "'");
  }
  std::string lastError = "no usable address";
  for (addrinfo* address = addresses; address; address = address->ai_next) {
    SOCKET candidate = ::socket(address->ai_family, address->ai_socktype, address->ai_protocol);
    if (candidate == INVALID_SOCKET) {
      lastError = socketError("socket");
      continue;
    }
    u_long nonBlocking = 1;
    ioctlsocket(candidate, FIONBIO, &nonBlocking);
    const int rc = ::connect(candidate, address->ai_addr, static_cast<int>(address->ai_addrlen));
    bool connected = rc == 0;
    if (!connected && WSAGetLastError() == WSAEWOULDBLOCK &&
        waitSocket(candidate, false, static_cast<int>(kConnectTimeout.count())) == 1) {
      int error = 0;
      int size = sizeof(error);
      getsockopt(candidate, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size);
      connected = error == 0;
      if (!connected) lastError = "connect failed (error " + std::to_string(error) + ")";
    } else if (!connected) {
      lastError = "connect timed out";
    }
    if (!connected) {
      closesocket(candidate);
      continue;
    }
    BOOL noDelay = TRUE;
    setsockopt(candidate, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&noDelay), sizeof(noDelay));
    socket_ = candidate;
    break;
  }
  freeaddrinfo(addresses);
  if (!isOpen()) {
    return Result::error(ErrorCodes::kDeviceOpenFailed,
                         "cannot connect to " + endpoint.host + ":" + port + ": " + lastError);
  }
  peer_ = endpoint.host + ":" + port;
  outstanding_ = 0;
  lost_ = false;
  return Result::success();
}

Result CmsisDapTcpTransport::close() {
  if (socket_ != INVALID_SOCKET) {
    shutdown(socket_, SD_BOTH);
    closesocket(socket_);
    socket_ = INVALID_SOCKET;
  }
  outstanding_ = 0;
  return Result::success();
}

Result CmsisDapTcpTransport::markLost(const char* code, const std::string& message) {
  lost_ = true;
  close();
  return Result::error(code, "tcp " + peer_ + ": " + message);
}

Result CmsisDapTcpTransport::writePacket(const uint8_t* data, size_t length,
                                         std::chrono::milliseconds timeout) {
  if (lost_) return Result::error(ErrorCodes::kDeviceRemoved, "tcp connection was lost");
  if (!isOpen()) return Result::error(ErrorCodes::kInvalidState, "tcp transport is not open");
  if (length > kTcpMaxPacket) {
    return Result::error(ErrorCodes::kPacketTooLarge,
                         "packet of " + std::to_string(length) + " bytes exceeds " +
                             std::to_string(kTcpMaxPacket));
  }
  std::vector<uint8_t> frame = tcpFrameHeader(length, kTypeRequest);
  frame.insert(frame.end(), data, data + length);
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  size_t sent = 0;
  while (sent < frame.size()) {
    const int rc = ::send(socket_, reinterpret_cast<const char*>(frame.data() + sent),
                          static_cast<int>(frame.size() - sent), 0);
    if (rc > 0) {
      sent += static_cast<size_t>(rc);
      continue;
    }
    if (WSAGetLastError() != WSAEWOULDBLOCK) return markLost(ErrorCodes::kDeviceRemoved, socketError("send"));
    const int ready = waitSocket(socket_, false, remainingMs(deadline));
    if (ready == 0) {
      // A partly written frame cannot be recovered on a byte stream.
      if (sent == 0) return Result::error(ErrorCodes::kWriteTimeout, "tcp send timed out");
      return markLost(ErrorCodes::kWriteTimeout, "tcp send timed out mid-frame");
    }
    if (ready < 0) return markLost(ErrorCodes::kDeviceRemoved, socketError("send poll"));
  }
  ++outstanding_;
  ++counters_.writeReports;
  counters_.writePayloadBytes += length;
  counters_.writeReportBytes += frame.size();
  return Result::success();
}

CmsisDapTcpTransport::RecvStatus CmsisDapTcpTransport::recvExact(
    uint8_t* data, size_t length, size_t& received,
    std::chrono::steady_clock::time_point deadline) {
  received = 0;
  while (received < length) {
    const int rc = ::recv(socket_, reinterpret_cast<char*>(data + received),
                          static_cast<int>(length - received), 0);
    if (rc > 0) {
      received += static_cast<size_t>(rc);
      continue;
    }
    if (rc == 0) return RecvStatus::Closed;
    if (WSAGetLastError() != WSAEWOULDBLOCK) return RecvStatus::Error;
    const int ready = waitSocket(socket_, true, remainingMs(deadline));
    if (ready == 0) return RecvStatus::Timeout;
    if (ready < 0) return RecvStatus::Error;
  }
  return RecvStatus::Ok;
}

Result CmsisDapTcpTransport::readFrame(std::vector<uint8_t>& payload,
                                       std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  uint8_t header[kTcpHeaderLength];
  size_t received = 0;
  RecvStatus status = recvExact(header, sizeof(header), received, deadline);
  if (status == RecvStatus::Timeout && received == 0) {
    return Result::error(ErrorCodes::kReadTimeout, "tcp response timed out");
  }
  if (status == RecvStatus::Closed) return markLost(ErrorCodes::kDeviceRemoved, "connection closed by the probe");
  if (status != RecvStatus::Ok) return markLost(ErrorCodes::kDeviceRemoved, "receive failed or timed out mid-frame");
  const int length = parseTcpFrameHeader(header, kTypeResponse);
  if (length < 0 || static_cast<size_t>(length) > kTcpMaxPacket) {
    return markLost(ErrorCodes::kMalformedResponse, "invalid response frame header");
  }
  payload.resize(static_cast<size_t>(length));
  status = recvExact(payload.data(), payload.size(), received, deadline);
  if (status == RecvStatus::Closed) return markLost(ErrorCodes::kDeviceRemoved, "connection closed by the probe");
  if (status != RecvStatus::Ok) return markLost(ErrorCodes::kDeviceRemoved, "receive failed or timed out mid-frame");
  ++counters_.readReports;
  counters_.readPayloadBytes += payload.size();
  counters_.readReportBytes += kTcpHeaderLength + payload.size();
  return Result::success();
}

Result CmsisDapTcpTransport::readPacket(uint8_t* data, size_t capacity, size_t& length,
                                        std::chrono::milliseconds timeout) {
  length = 0;
  if (lost_) return Result::error(ErrorCodes::kDeviceRemoved, "tcp connection was lost");
  if (!isOpen()) return Result::error(ErrorCodes::kInvalidState, "tcp transport is not open");
  std::vector<uint8_t> payload;
  for (;;) {
    const Result result = readFrame(payload, timeout);
    if (!result.ok) return result;  // a timed-out request stays outstanding
    // With more than one outstanding, this answers an earlier timed-out request.
    const bool late = outstanding_ > 1;
    if (outstanding_ > 0) --outstanding_;
    if (!late) break;
  }
  if (payload.size() > capacity) {
    return Result::error(ErrorCodes::kPacketTooLarge, "tcp response larger than the read buffer");
  }
  std::copy(payload.begin(), payload.end(), data);
  length = payload.size();
  return Result::success();
}

Result CmsisDapTcpTransport::drainInput(std::chrono::milliseconds timeout) {
  if (!isOpen()) return Result::success();
  // Only late responses to timed-out requests can be pending.
  std::vector<uint8_t> payload;
  while (outstanding_ > 0) {
    if (!readFrame(payload, timeout).ok) break;
    --outstanding_;
  }
  return Result::success();
}

}  // namespace cmsis_dap_helper
