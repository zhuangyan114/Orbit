#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <windows.h>

#include "cmsis_dap_hid_transport.h"
#include "cmsis_dap_protocol.h"
#include "cmsis_dap_target.h"
#include "cmsis_dap_transport.h"
#include "cortex_m_debug.h"
#include "json_rpc.h"
#include "mock_transport.h"
#include "trace_control.h"

namespace cmsis_dap_helper {
namespace {

constexpr int kProtocolVersion = 1;
constexpr char kHelperVersion[] = "0.1.0";
constexpr char kPlatform[] = "win32-x64";
constexpr uint32_t kStm32F4FlashSr = 0x40023C0Cu;
constexpr uint32_t kStm32F4FlashCr = 0x40023C10u;

// Upper bounds for one readMemory/readMemoryBlock JSON-RPC call. Both are
// far below what the helper could buffer; they exist to keep the JSON
// payload and the transfer time bounded.
constexpr uint32_t kMaxMemoryReadBytes = 65536;
constexpr uint32_t kMaxMemoryBlockWords = 16384;

void diag(const std::string& message) {
  std::cerr << "[cmsis-dap-helper] " << message << std::endl;
}

// ---------------------------------------------------------------------------
// Request parameter helpers
// ---------------------------------------------------------------------------

std::optional<std::string> stringField(const JsonValue& params, const char* key) {
  const JsonValue* value = params.get(key);
  if (!value || value->kind != JsonValue::Kind::String) return std::nullopt;
  return value->string;
}

std::optional<uint64_t> uintField(const JsonValue& params, const char* key) {
  const JsonValue* value = params.get(key);
  if (!value || value->kind != JsonValue::Kind::Number) return std::nullopt;
  return static_cast<uint64_t>(value->number);
}

std::optional<bool> boolField(const JsonValue& params, const char* key) {
  const JsonValue* value = params.get(key);
  if (!value || value->kind != JsonValue::Kind::Boolean) return std::nullopt;
  return value->boolean;
}

std::optional<std::vector<uint8_t>> byteArrayField(const JsonValue& params, const char* key,
                                                   size_t maximum) {
  const JsonValue* value = params.get(key);
  if (!value || value->kind != JsonValue::Kind::Array || value->array.size() > maximum) return std::nullopt;
  std::vector<uint8_t> result;
  result.reserve(value->array.size());
  for (const JsonValue& item : value->array) {
    if (item.kind != JsonValue::Kind::Number || item.number < 0 || item.number > 255 ||
        item.number != static_cast<uint64_t>(item.number)) return std::nullopt;
    result.push_back(static_cast<uint8_t>(item.number));
  }
  return result;
}

std::string normalizeHex(const std::string& input) {
  std::string out;
  out.reserve(input.size());
  for (const char ch : input) {
    if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
      out.push_back(static_cast<char>(ch >= 'a' && ch <= 'f' ? ch - 'a' + 'A' : ch));
    }
  }
  return out;
}

std::string hexWord(uint32_t value) {
  std::ostringstream out;
  out << "0x" << std::hex << value;
  return out.str();
}

bool containsInsensitive(const std::string& haystack, const char* needle) {
  std::string lower;
  lower.reserve(haystack.size());
  for (const char ch : haystack) {
    lower.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  return lower.find(needle) != std::string::npos;
}

// Name-based probe identification used only when open() is called without any
// device filter. Never guesses a transport; it only prevents opening an
// arbitrary HID device (keyboard, mouse, touchscreen, ...) as a debug probe.
bool isCmsisDapProbeName(const std::string& name) {
  return containsInsensitive(name, "cmsis-dap") || containsInsensitive(name, "daplink");
}

// ---------------------------------------------------------------------------
// Result JSON builders
// ---------------------------------------------------------------------------

std::string resultJson(bool ok, const std::string& message, const std::string& targetState,
                       long long elapsedMs, const std::string& dataJson = "{}",
                       const std::string& errorCode = "",
                       const std::string& diagnosticsJson = "{}") {
  std::string result = std::string("{\"ok\":") + (ok ? "true" : "false") +
                       ",\"message\":\"" + jsonEscape(message) +
                       "\",\"targetState\":\"" + jsonEscape(targetState) +
                       "\",\"elapsedMs\":" + std::to_string(elapsedMs) +
                       ",\"data\":" + dataJson;
  if (!errorCode.empty()) result += ",\"errorCode\":\"" + jsonEscape(errorCode) + "\"";
  if (!diagnosticsJson.empty()) result += ",\"diagnostics\":" + diagnosticsJson;
  result += "}";
  return result;
}

std::string responseEnvelope(const JsonValue& id, const std::string& result) {
  std::ostringstream out;
  out << "{\"id\":" << jsonSerialize(id) << ",\"result\":" << result << "}";
  return out.str();
}

std::string protocolError(const std::string& rawLine, const std::string& message) {
  // Try to echo the request id back so the client can match the failure.
  std::string idJson = "null";
  try {
    const JsonValue request = JsonParser(rawLine).parse();
    const JsonValue* id = request.get("id");
    if (id) idJson = jsonSerialize(*id);
  } catch (...) {
  }
  return "{\"id\":" + idJson + ",\"result\":" +
         resultJson(false, message, "Error", 0, "{}", "ProtocolError") + "}";
}

// ---------------------------------------------------------------------------
// Channel state
// ---------------------------------------------------------------------------

struct Channel {
  std::string requestedTransport;  // from --transport=, default "hid"
  std::unique_ptr<CmsisDapTransport> transport;
  DeviceDescriptor device;
  bool opened = false;
  bool connected = false;
  uint16_t packetSize = 0;  // effective packet size from the last DAP_Info
  bool flashAlgorithmLoaded = false;
  uint32_t flashAlgorithmAddress = 0;
  std::vector<uint8_t> flashAlgorithmCode;
  bool flashPageBufferValid = false;
  uint32_t flashPageBufferAddress = 0;
  uint32_t flashPageTargetAddress = 0;
  uint32_t flashPageSize = 0;
  std::vector<uint8_t> flashPageData;

  void clearFlashPageBuffer() {
    flashPageBufferValid = false;
    flashPageBufferAddress = 0;
    flashPageTargetAddress = 0;
    flashPageSize = 0;
    flashPageData.clear();
  }

  void clearFlashAlgorithmState() {
    flashAlgorithmLoaded = false;
    flashAlgorithmAddress = 0;
    flashAlgorithmCode.clear();
    clearFlashPageBuffer();
  }

  std::string state() const {
    if (!opened) return "Disconnected";
    return "Unknown";
  }

  CmsisDapTransport* requireTransport() {
    if (!transport) return nullptr;
    return transport.get();
  }

  Result ensureOpen() {
    if (!opened || !transport || !transport->isOpen()) {
      return Result::error(ErrorCodes::kInvalidState, "device is not open");
    }
    return Result::success();
  }

  Result ensureReady() {
    const Result openResult = ensureOpen();
    if (!openResult.ok) return openResult;
    if (!connected) {
      return Result::error(ErrorCodes::kInvalidState,
                           "DAP_Connect must complete before DP/AP access");
    }
    return Result::success();
  }
};

// Creates the transport for the requested name. "hid" is the real Windows
// CMSIS-DAP v1 transport; "mock" is the in-memory transport used by mock
// tests. WinUSB is rejected before this point with kTransportNotSupported.
std::unique_ptr<CmsisDapTransport> createTransport(const std::string& name, std::string& error) {
  if (name == "hid") return std::make_unique<CmsisDapHidTransport>();
  if (name == "mock") return std::make_unique<MockCmsisDapTransport>();
  error = "transport '" + name + "' is not implemented yet";
  return nullptr;
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

std::string handleHello(const JsonValue& params) {
  const auto started = std::chrono::steady_clock::now();
  const uint64_t clientProtocol = uintField(params, "clientProtocol").value_or(0);
  const std::string data =
      "{\"protocol\":" + std::to_string(kProtocolVersion) +
      ",\"helperVersion\":\"" + kHelperVersion +
      "\",\"platform\":\"" + kPlatform +
      "\",\"capabilities\":[\"enumDevices\",\"hidTransport\",\"dapInfo\",\"dapConnect\","
      "\"dapDisconnect\",\"dapTransfer\",\"dapTransferBlock\",\"swDp\",\"memAp\","
      "\"readMemory\",\"readMemoryBlock\",\"flashAlgorithm\",\"getState\",\"halt\",\"run\","
      "\"reset\",\"stepInstruction\",\"readRegister\"]}";
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (clientProtocol != static_cast<uint64_t>(kProtocolVersion)) {
    return resultJson(false, "protocol version mismatch", "Disconnected", elapsedMs, data,
                      "ProtocolVersionMismatch",
                      "{\"clientProtocol\":" + std::to_string(clientProtocol) +
                          ",\"protocol\":" + std::to_string(kProtocolVersion) + "}");
  }
  return resultJson(true, "hello", "Disconnected", elapsedMs, data);
}

std::string handleShutdown() {
  return resultJson(true, "shutdown", "Disconnected", 0);
}

std::string handleEnumDevices(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  std::string transportName = stringField(params, "transport").value_or(channel.requestedTransport);
  if (transportName.empty()) transportName = "hid";
  if (transportName == "winusb") {
    return resultJson(false, "CMSIS-DAP v2/WinUSB transport is not implemented in this stage",
                      channel.state(), 0, "{}", ErrorCodes::kTransportNotSupported,
                      "{\"transport\":\"winusb\",\"implemented\":[\"hid\"]}");
  }
  std::string error;
  std::unique_ptr<CmsisDapTransport> transport = createTransport(transportName, error);
  if (!transport) {
    return resultJson(false, error, channel.state(), 0, "{}", ErrorCodes::kTransportNotSupported,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  DeviceSelector selector;
  const std::optional<std::string> vid = stringField(params, "vid");
  const std::optional<std::string> pid = stringField(params, "pid");
  const std::optional<std::string> serial = stringField(params, "serial");
  const std::optional<std::string> product = stringField(params, "product");
  const std::optional<std::string> path = stringField(params, "path");
  if (vid) selector.vid = normalizeHex(*vid);
  if (pid) selector.pid = normalizeHex(*pid);
  if (serial) selector.serial = *serial;
  if (product) selector.product = *product;
  if (path) selector.path = *path;

  std::vector<DeviceDescriptor> devices;
  const Result result = transport->enumerate(selector, devices);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  std::string devicesJson = "[";
  for (size_t i = 0; i < devices.size(); ++i) {
    if (i > 0) devicesJson += ",";
    const DeviceDescriptor& d = devices[i];
    devicesJson +=
        "{\"path\":\"" + jsonEscape(d.path) + "\",\"vid\":\"" + jsonEscape(d.vid) +
        "\",\"pid\":\"" + jsonEscape(d.pid) + "\",\"manufacturer\":\"" + jsonEscape(d.manufacturer) +
        "\",\"product\":\"" + jsonEscape(d.product) + "\",\"serial\":\"" + jsonEscape(d.serial) +
        "\",\"inputReportLength\":" + std::to_string(d.inputReportLength) +
        ",\"outputReportLength\":" + std::to_string(d.outputReportLength) +
        ",\"reportId\":" + std::to_string(d.reportId) +
        ",\"usagePage\":" + std::to_string(d.usagePage) + ",\"usage\":" + std::to_string(d.usage) +
        ",\"transport\":\"" + jsonEscape(d.transport) + "\"}";
  }
  devicesJson += "]";
  return resultJson(true, "enumerated " + std::to_string(devices.size()) + " device(s)",
                    channel.state(), elapsedMs, "{\"devices\":" + devicesJson + "}");
}

std::string handleOpen(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  if (channel.opened) {
    return resultJson(false, "a device is already open; close it first", channel.state(), 0, "{}",
                      ErrorCodes::kInvalidState);
  }
  std::string transportName = stringField(params, "transport").value_or(channel.requestedTransport);
  if (transportName.empty()) transportName = "hid";
  if (transportName == "winusb") {
    return resultJson(false, "CMSIS-DAP v2/WinUSB transport is not implemented in this stage",
                      channel.state(), 0, "{}", ErrorCodes::kTransportNotSupported,
                      "{\"transport\":\"winusb\",\"implemented\":[\"hid\"]}");
  }
  std::string error;
  std::unique_ptr<CmsisDapTransport> transport = createTransport(transportName, error);
  if (!transport) {
    return resultJson(false, error, channel.state(), 0, "{}", ErrorCodes::kTransportNotSupported,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  DeviceSelector selector;
  const std::optional<std::string> vid = stringField(params, "vid");
  const std::optional<std::string> pid = stringField(params, "pid");
  const std::optional<std::string> serial = stringField(params, "serial");
  const std::optional<std::string> path = stringField(params, "path");
  if (vid) selector.vid = normalizeHex(*vid);
  if (pid) selector.pid = normalizeHex(*pid);
  if (serial) selector.serial = *serial;
  if (path) selector.path = *path;

  std::vector<DeviceDescriptor> devices;
  Result result = transport->enumerate(selector, devices);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  if (devices.empty()) {
    return resultJson(false, "no matching CMSIS-DAP HID device found", channel.state(), elapsedMs, "{}",
                      ErrorCodes::kDeviceNotFound,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  // Without any filter, refuse to open an arbitrary HID device (keyboards,
  // mice, touchscreens...). Prefer a device whose name identifies it as a
  // CMSIS-DAP probe; otherwise ask the caller for explicit filters.
  const DeviceDescriptor* selected = nullptr;
  if (selector.path.empty() && selector.vid.empty() && selector.pid.empty() &&
      selector.serial.empty() && selector.product.empty()) {
    for (const DeviceDescriptor& candidate : devices) {
      if (isCmsisDapProbeName(candidate.product) || isCmsisDapProbeName(candidate.serial) ||
          isCmsisDapProbeName(candidate.manufacturer)) {
        selected = &candidate;
        break;
      }
    }
    if (!selected) {
      return resultJson(false,
                        "no device filters were given and no enumerated device name identifies a "
                        "CMSIS-DAP probe; pass vid/pid/serial to select a device",
                        channel.state(), elapsedMs, "{}", ErrorCodes::kDeviceNotFound,
                        "{\"deviceCount\":" + std::to_string(devices.size()) + "}");
    }
  } else {
    selected = &devices.front();
  }
  const DeviceDescriptor& device = *selected;
  result = transport->open(device);
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  channel.transport = std::move(transport);
  channel.device = device;
  channel.opened = true;
  channel.connected = false;
  // Clear stale input reports left by a previous session (some firmware does
  // not flush its report buffer on open). Best-effort.
  channel.transport->drainInput(std::chrono::milliseconds(100));
  diag("opened device vid=" + device.vid + " pid=" + device.pid + " product=" + device.product +
       " serial=" + device.serial + " inputReportLength=" + std::to_string(device.inputReportLength) +
       " outputReportLength=" + std::to_string(device.outputReportLength) +
       " reportId=" + std::to_string(device.reportId));
  return resultJson(
      true, "device opened", channel.state(), elapsedMs,
      "{\"path\":\"" + jsonEscape(device.path) + "\",\"vid\":\"" + jsonEscape(device.vid) +
          "\",\"pid\":\"" + jsonEscape(device.pid) + "\",\"manufacturer\":\"" +
          jsonEscape(device.manufacturer) + "\",\"product\":\"" + jsonEscape(device.product) +
          "\",\"serial\":\"" + jsonEscape(device.serial) + "\",\"inputReportLength\":" +
          std::to_string(device.inputReportLength) + ",\"outputReportLength\":" +
          std::to_string(device.outputReportLength) + ",\"reportId\":" +
          std::to_string(device.reportId) + ",\"transport\":\"" + jsonEscape(transportName) + "\"}");
}

std::string handleClose(Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  if (channel.transport) {
    if (channel.connected && channel.transport->isOpen()) {
      // Symmetric lifecycle: release the target link before closing the device.
      CmsisDapProtocol protocol(channel.transport.get());
      const Result disconnectResult =
          protocol.disconnect(std::chrono::milliseconds(2000));
      if (!disconnectResult.ok) {
        diag("close: DAP_Disconnect failed: " + disconnectResult.message);
      }
    }
    const Result closeResult = channel.transport->close();
    if (!closeResult.ok) {
      channel.clearFlashAlgorithmState();
      return resultJson(false, closeResult.message, channel.state(), 0, "{}", closeResult.errorCode);
    }
  }
  channel.transport.reset();
  channel.opened = false;
  channel.connected = false;
  channel.clearFlashAlgorithmState();
  return resultJson(true, "device closed", "Disconnected", 0);
}

std::string packetSizeSourceName(PacketSizeSource source) {  switch (source) {
    case PacketSizeSource::ProtocolInfo:
      return "protocol-info";
    case PacketSizeSource::HidReportCapability:
      return "hid-report-capability";
    default:
      return "unavailable";
  }
}

std::string handleGetInfo(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result openResult = channel.ensureOpen();
  if (!openResult.ok) {
    return resultJson(false, openResult.message, channel.state(), 0, "{}", openResult.errorCode);
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(2000));
  CmsisDapProtocol protocol(channel.transport.get());
  DapInfoResult info;
  const Result result = protocol.getInfo(info, timeout);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      "{\"transport\":\"" + jsonEscape(channel.transport->transportName()) + "\"}");
  }
  std::string capabilitiesJson = "[";
  for (size_t i = 0; i < info.capabilities.size(); ++i) {
    if (i > 0) capabilitiesJson += ",";
    capabilitiesJson += std::to_string(info.capabilities[i]);
  }
  capabilitiesJson += "]";
  const std::string packetCountJson =
      info.packetCount != 0 ? std::to_string(info.packetCount) : "null";
  const std::string packetSizeJson = info.packetSize != 0 ? std::to_string(info.packetSize) : "null";
  const std::string data =
      "{\"vendor\":\"" + jsonEscape(info.vendor) + "\",\"product\":\"" +
      jsonEscape(info.product) + "\",\"serial\":\"" + jsonEscape(info.serial) +
      "\",\"firmwareVersion\":\"" + jsonEscape(info.firmwareVersion) +
      "\",\"protocolVersion\":\"" + jsonEscape(info.protocolVersion) +
      "\",\"capabilities\":" + capabilitiesJson + ",\"packetCount\":" + packetCountJson +
      ",\"packetSize\":" + packetSizeJson + ",\"protocolPacketSize\":" + packetSizeJson +
      ",\"effectivePacketSize\":" + std::to_string(info.effectivePacketSize) +
      ",\"packetSizeSource\":\"" + packetSizeSourceName(info.packetSizeSource) + "\"}";
  channel.packetSize = info.effectivePacketSize;
  return resultJson(true, "DAP_Info completed", channel.state(), elapsedMs, data);
}

std::string targetDiagnosticsJson(const DapTransferDiagnostics& diag, uint16_t packetSize);

std::string handleConnect(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result openResult = channel.ensureOpen();
  if (!openResult.ok) {
    return resultJson(false, openResult.message, channel.state(), 0, "{}", openResult.errorCode);
  }
  const std::string port = stringField(params, "port").value_or("SWD");
  if (port != "SWD" && port != "JTAG") {
    return resultJson(false, "port must be SWD or JTAG", channel.state(), 0, "{}",
                      ErrorCodes::kProtocolError, "{\"port\":\"" + jsonEscape(port) + "\"}");
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(2000));
  const uint64_t speedKHz = uintField(params, "speedKHz").value_or(1000);
  if (speedKHz == 0 || speedKHz > 4000000) {
    return resultJson(false, "speedKHz must be in 1..4000000", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest);
  }
  const bool resetTargetBeforeConnect = boolField(params, "resetTarget").value_or(false);
  CmsisDapProtocol protocol(channel.transport.get());
  const auto releaseAfterConnectFailure = [&]() {
    channel.connected = false;
    if (!channel.transport || !channel.transport->isOpen()) return;
    const Result disconnectResult = protocol.disconnect(std::chrono::milliseconds(2000));
    if (!disconnectResult.ok) {
      diag("connect cleanup: DAP_Disconnect failed code=" + disconnectResult.errorCode +
           " message=" + disconnectResult.message);
    }
  };
  uint8_t connectedPort = 0;
  const Result result =
      protocol.connect(port == "JTAG" ? kPortJtag : kPortSwd, connectedPort, timeout,
                       static_cast<uint32_t>(speedKHz * 1000), resetTargetBeforeConnect);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    // DAP_Connect may have selected a port before a later initialization
    // command failed. Release that probe session before the owner closes the
    // HID handle, otherwise the next session can inherit a half-connected
    // CMSIS-DAP state.
    releaseAfterConnectFailure();
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode);
  }

  channel.connected = true;
  const std::string connectedName =
      connectedPort == kPortJtag ? "JTAG" : (connectedPort == kPortSwd ? "SWD" : "default");
  return resultJson(true, "DAP_Connect completed", channel.state(), elapsedMs,
                     "{\"port\":\"" + connectedName + "\",\"connectResponse\":" +
                         std::to_string(connectedPort) + ",\"speedKHz\":" +
                         std::to_string(speedKHz) + ",\"swdPinInput\":" +
                         std::to_string(protocol.lastSwjPinInput()) + "}");
}

std::string handleDisconnect(Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result openResult = channel.ensureOpen();
  if (!openResult.ok) {
    return resultJson(false, openResult.message, channel.state(), 0, "{}", openResult.errorCode);
  }
  CmsisDapProtocol protocol(channel.transport.get());
  const Result result = protocol.disconnect(std::chrono::milliseconds(2000));
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    channel.clearFlashAlgorithmState();
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode);
  }
  channel.connected = false;
  channel.clearFlashAlgorithmState();
  return resultJson(true, "DAP_Disconnect completed", channel.state(), elapsedMs);
}

// ---------------------------------------------------------------------------
// DAP-03: SW-DP / MEM-AP registers and Cortex-M 32-bit memory reads
// ---------------------------------------------------------------------------

std::string targetDiagnosticsJson(const DapTransferDiagnostics& diag, uint16_t packetSize) {
  return "{\"chunks\":" + std::to_string(diag.chunks) + ",\"packets\":" +
         std::to_string(diag.packets) + ",\"blockReads\":" + std::to_string(diag.blockReads) +
         ",\"blockWrites\":" + std::to_string(diag.blockWrites) +
         ",\"waitRetries\":" + std::to_string(diag.waitRetries) +
         ",\"faultClears\":" + std::to_string(diag.faultClears) +
         ",\"packetSize\":" + std::to_string(packetSize) + "}";
}

std::string handleDpRead(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> reg = uintField(params, "reg");
  if (!reg || *reg > 0x0C || (*reg & 0x03) != 0) {
    return resultJson(false, "dpRead requires reg in {0, 4, 8, 12}", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest);
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(2000));
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  uint32_t value = 0;
  const Result result = target.readDp(static_cast<uint8_t>(*reg), value, diag);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  return resultJson(true, "DP register read", channel.state(), elapsedMs,
                    "{\"reg\":" + std::to_string(*reg) + ",\"value\":" + std::to_string(value) +
                        "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

std::string handleDpWrite(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> reg = uintField(params, "reg");
  const std::optional<uint64_t> valueOpt = uintField(params, "value");
  if (!reg || *reg > 0x0C || (*reg & 0x03) != 0 || !valueOpt || *valueOpt > 0xFFFFFFFF) {
    return resultJson(false, "dpWrite requires reg in {0, 4, 8, 12} and a 32-bit value",
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  const Result result =
      target.writeDp(static_cast<uint8_t>(*reg), static_cast<uint32_t>(*valueOpt), diag);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  return resultJson(true, "DP register written", channel.state(), elapsedMs,
                    "{\"reg\":" + std::to_string(*reg) + "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

std::string handleApRead(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> addr = uintField(params, "addr");
  if (!addr || (*addr != kApRegCsw && *addr != kApRegTar && *addr != kApRegDrw)) {
    return resultJson(false, "apRead requires addr in {0 (CSW), 4 (TAR), 12 (DRW)}",
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(2000));
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  uint32_t value = 0;
  const Result result = target.readAp(static_cast<uint8_t>(*addr), value, diag);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  return resultJson(true, "AP register read", channel.state(), elapsedMs,
                    "{\"addr\":" + std::to_string(*addr) + ",\"value\":" + std::to_string(value) +
                        "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

std::string handleApWrite(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> addr = uintField(params, "addr");
  const std::optional<uint64_t> valueOpt = uintField(params, "value");
  if (!addr || (*addr != kApRegCsw && *addr != kApRegTar && *addr != kApRegDrw) || !valueOpt ||
      *valueOpt > 0xFFFFFFFF) {
    return resultJson(false, "apWrite requires addr in {0, 4, 12} and a 32-bit value",
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  const Result result =
      target.writeAp(static_cast<uint8_t>(*addr), static_cast<uint32_t>(*valueOpt), diag);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  return resultJson(true, "AP register written", channel.state(), elapsedMs,
                    "{\"addr\":" + std::to_string(*addr) + "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

std::string handleReadMemory(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> address = uintField(params, "address");
  const std::optional<uint64_t> size = uintField(params, "size");
  if (!address || *address > 0xFFFFFFFF || !size || *size == 0 || *size > kMaxMemoryReadBytes) {
    return resultJson(false,
                      "readMemory requires address (32-bit) and size in 1.." +
                          std::to_string(kMaxMemoryReadBytes),
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(5000));
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  std::vector<uint8_t> bytes;
  const Result result = target.readMemory(static_cast<uint32_t>(*address),
                                          static_cast<uint32_t>(*size), bytes, diag);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  std::string bytesJson = "[";
  for (size_t i = 0; i < bytes.size(); ++i) {
    if (i > 0) bytesJson += ",";
    bytesJson += std::to_string(bytes[i]);
  }
  bytesJson += "]";
  return resultJson(true, "memory read", channel.state(), elapsedMs,
                    "{\"address\":" + std::to_string(*address) + ",\"size\":" +
                        std::to_string(*size) + ",\"bytes\":" + bytesJson + "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

std::string handleReadMemoryBlock(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> address = uintField(params, "address");
  const std::optional<uint64_t> wordCount = uintField(params, "wordCount");
  if (!address || *address > 0xFFFFFFFF || (*address & 0x03) != 0 || !wordCount ||
      *wordCount == 0 || *wordCount > kMaxMemoryBlockWords) {
    return resultJson(false,
                      "readMemoryBlock requires a 4-byte aligned address and wordCount in 1.." +
                          std::to_string(kMaxMemoryBlockWords),
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(5000));
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  std::vector<uint32_t> words;
  const Result result = target.readMemoryBlock(static_cast<uint32_t>(*address),
                                               static_cast<uint32_t>(*wordCount), words, diag);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  std::string wordsJson = "[";
  for (size_t i = 0; i < words.size(); ++i) {
    if (i > 0) wordsJson += ",";
    wordsJson += std::to_string(words[i]);
  }
  wordsJson += "]";
  return resultJson(true, "memory block read", channel.state(), elapsedMs,
                    "{\"address\":" + std::to_string(*address) + ",\"wordCount\":" +
                        std::to_string(*wordCount) + ",\"words\":" + wordsJson + "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

// ---------------------------------------------------------------------------
// DAP-04: Cortex-M CoreDebug state and register access
// ---------------------------------------------------------------------------

std::string cortexStateName(const CortexMDebugState& state) {
  return state.halted ? "Halted" : "Running";
}

std::string cortexSnapshotJson(const CortexRegisterSnapshot& snapshot) {
  return "{\"dhcsrValid\":" + std::string(snapshot.dhcsrValid ? "true" : "false") +
         ",\"dhcsr\":" + std::to_string(snapshot.dhcsr) +
         ",\"registersValid\":" + std::string(snapshot.registersValid ? "true" : "false") +
         ",\"pc\":" + std::to_string(snapshot.pc) +
         ",\"lr\":" + std::to_string(snapshot.lr) +
         ",\"sp\":" + std::to_string(snapshot.sp) +
         ",\"xpsr\":" + std::to_string(snapshot.xpsr) +
         ",\"r0\":" + std::to_string(snapshot.r0) +
         ",\"r1\":" + std::to_string(snapshot.r1) +
         ",\"r2\":" + std::to_string(snapshot.r2) +
         ",\"r3\":" + std::to_string(snapshot.r3) +
         ",\"r9\":" + std::to_string(snapshot.r9) +
         ",\"faultStatusValid\":" + std::string(snapshot.faultStatusValid ? "true" : "false") +
         ",\"cfsr\":" + std::to_string(snapshot.cfsr) +
         ",\"hfsr\":" + std::to_string(snapshot.hfsr) +
         ",\"dfsr\":" + std::to_string(snapshot.dfsr) +
         ",\"bfar\":" + std::to_string(snapshot.bfar) +
         ",\"mmfar\":" + std::to_string(snapshot.mmfar) + "}";
}

std::string cortexDiagnosticsJson(const char* operation,
                                  uint32_t timeoutMs,
                                  const DapTransferDiagnostics& diag,
                                  const std::string& extra = "",
                                  const CortexMDebugDiagnostics* algorithm = nullptr) {
  std::string json = "{\"operation\":\"" + std::string(operation) +
                     "\",\"owner\":\"cmsis-dap\",\"helperPid\":" +
                     std::to_string(static_cast<unsigned long long>(GetCurrentProcessId())) +
                     ",\"timeoutMs\":" + std::to_string(timeoutMs) +
                     ",\"chunks\":" + std::to_string(diag.chunks) +
                     ",\"packets\":" + std::to_string(diag.packets) +
                     ",\"blockReads\":" + std::to_string(diag.blockReads) +
                     ",\"blockWrites\":" + std::to_string(diag.blockWrites) +
                     ",\"waitRetries\":" + std::to_string(diag.waitRetries) +
                     ",\"faultClears\":" + std::to_string(diag.faultClears);
  if (algorithm) {
    json += ",\"algorithmOperation\":\"" + jsonEscape(algorithm->operation) +
            "\",\"entry\":" + std::to_string(algorithm->entry) +
            ",\"bkptAddress\":" + std::to_string(algorithm->bkptAddress) +
            ",\"algorithmAddress\":" + std::to_string(algorithm->algorithmAddress) +
            ",\"algorithmLength\":" + std::to_string(algorithm->algorithmLength) +
            ",\"staticBase\":" + std::to_string(algorithm->staticBase) +
            ",\"stackPointer\":" + std::to_string(algorithm->stackPointer) +
            ",\"pageBufferAddress\":" + std::to_string(algorithm->pageBufferAddress) +
            ",\"flashAddress\":" + std::to_string(algorithm->targetAddress) +
            ",\"flashSize\":" + std::to_string(algorithm->size) +
            ",\"algorithmElapsedMs\":" + std::to_string(algorithm->elapsedMs) +
            ",\"before\":" + cortexSnapshotJson(algorithm->before) +
            ",\"after\":" + cortexSnapshotJson(algorithm->after);
    if (!algorithm->errorCode.empty()) {
      json += ",\"algorithmErrorCode\":\"" + jsonEscape(algorithm->errorCode) + "\"";
    }
  }
  if (!extra.empty()) json += "," + extra;
  json += "}";
  return json;
}

std::optional<uint32_t> controlTimeoutMs(const JsonValue& params) {
  const uint64_t timeout = uintField(params, "timeoutMs").value_or(1000);
  if (timeout == 0 || timeout > 10000) return std::nullopt;
  return static_cast<uint32_t>(timeout);
}

std::string coreFailure(const Result& result, const char* operation, Channel& channel,
                        const std::chrono::steady_clock::time_point& started,
                        uint32_t timeoutMs, const DapTransferDiagnostics& diag,
                        const std::string& extra = "",
                        const CortexMDebugDiagnostics* algorithm = nullptr);
std::string invalidControlTimeout(const char* operation, Channel& channel);

std::string handleFlashAlgorithm(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    channel.clearFlashAlgorithmState();
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("flashAlgorithm", channel);
  const auto operation = stringField(params, "operation");
  const auto code = byteArrayField(params, "algorithm", 128 * 1024);
  const auto data = byteArrayField(params, "data", 64 * 1024);
  const auto algorithmAddress = uintField(params, "algorithmAddress");
  const auto entry = uintField(params, "entry");
  const auto bkptAddress = uintField(params, "bkptAddress");
  const auto stackPointer = uintField(params, "stackPointer");
  const auto stackSize = uintField(params, "stackSize").value_or(0x1000);
  const auto pageBufferAddress = uintField(params, "pageBufferAddress");
  const auto targetAddress = uintField(params, "targetAddress");
  const auto size = uintField(params, "size");
  const auto staticBase = uintField(params, "staticBase").value_or(0);
  const auto clockHz = uintField(params, "clockHz").value_or(4000000);
  const JsonValue* reusePageBufferValue = params.get("reusePageBuffer");
  const auto reusePageBuffer = boolField(params, "reusePageBuffer");
  if (!operation || (*operation != "init" && *operation != "uninit" && *operation != "eraseSector" &&
                    *operation != "programPage" && *operation != "verify") || !code || code->empty() ||
      !data || !algorithmAddress || !entry || !bkptAddress || !stackPointer || !pageBufferAddress ||
      !targetAddress || !size || *algorithmAddress > 0xFFFFFFFFu || *entry > 0xFFFFFFFFu ||
      *bkptAddress > 0xFFFFFFFFu || *stackPointer > 0xFFFFFFFFu || *pageBufferAddress > 0xFFFFFFFFu ||
      stackSize > 0xFFFFFFFFu || staticBase > 0xFFFFFFFFu || *targetAddress > 0xFFFFFFFFu ||
      *size > 0x10000u || clockHz > 0xFFFFFFFFu ||
      (reusePageBufferValue && !reusePageBuffer.has_value()) ||
      ((*operation == "programPage" || *operation == "verify") && data->size() < *size)) {
    return resultJson(false, "flashAlgorithm parameters are invalid", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest,
                      "{\"operation\":\"flashAlgorithm\"}");
  }

  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult = target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    channel.clearFlashAlgorithmState();
    return coreFailure(powerResult, "flashAlgorithm", channel, started, *timeout, diag);
  }

  FlashAlgorithmRunRequest request;
  request.operation = *operation;
  request.code = &code.value();
  request.data = &data.value();
  request.algorithmAddress = static_cast<uint32_t>(*algorithmAddress);
  request.entry = static_cast<uint32_t>(*entry);
  request.bkptAddress = static_cast<uint32_t>(*bkptAddress);
  request.stackPointer = static_cast<uint32_t>(*stackPointer);
  request.stackSize = static_cast<uint32_t>(stackSize);
  request.pageBufferAddress = static_cast<uint32_t>(*pageBufferAddress);
  request.targetAddress = static_cast<uint32_t>(*targetAddress);
  request.size = static_cast<uint32_t>(*size);
  request.staticBase = static_cast<uint32_t>(staticBase);
  request.timeoutMs = *timeout;
  request.loadAlgorithmCode = !channel.flashAlgorithmLoaded
                              || channel.flashAlgorithmAddress != request.algorithmAddress
                              || channel.flashAlgorithmCode != code.value();
  const bool reuseRequested = reusePageBuffer.value_or(false);
  if (reuseRequested) {
    const bool reuseValid = *operation == "verify" && channel.flashPageBufferValid &&
                            channel.flashAlgorithmLoaded &&
                            channel.flashAlgorithmAddress == request.algorithmAddress &&
                            channel.flashAlgorithmCode == code.value() &&
                            channel.flashPageBufferAddress == request.pageBufferAddress &&
                            channel.flashPageTargetAddress == request.targetAddress &&
                            channel.flashPageSize == request.size &&
                            channel.flashPageData == data.value();
    if (!reuseValid) {
      return resultJson(false,
                        "page buffer reuse does not match the immediately preceding successful ProgramPage",
                        channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest,
                        "{\"operation\":\"flashAlgorithm\",\"pageBufferReused\":false}");
    }
    request.loadPageData = false;
  }
  if (*operation == "init") {
    request.r0 = 0x08000000u;
    request.r1 = static_cast<uint32_t>(clockHz);
  } else if (*operation == "programPage" || *operation == "verify") {
    request.r0 = request.targetAddress;
    request.r1 = request.size;
    request.r2 = request.pageBufferAddress;
  } else if (*operation == "eraseSector") {
    request.r0 = request.targetAddress;
  }
  std::vector<uint32_t> flashRegistersBefore;
  const Result flashBeforeResult = target.readMemoryBlock(kStm32F4FlashSr, 2, flashRegistersBefore, diag,
                                                          std::chrono::milliseconds(*timeout));
  const bool flashRegistersBeforeValid = flashBeforeResult.ok && flashRegistersBefore.size() == 2;
  const uint32_t flashStatusBefore = flashRegistersBeforeValid ? flashRegistersBefore[0] : 0;
  const uint32_t flashControlBefore = flashRegistersBeforeValid ? flashRegistersBefore[1] : 0;
  const std::string flashBeforeDiagnostics =
      ",\"flashStatusBeforeValid\":" + std::string(flashRegistersBeforeValid ? "true" : "false") +
      (flashRegistersBeforeValid
           ? ",\"flashStatusBefore\":" + std::to_string(flashStatusBefore) +
                 ",\"flashControlBefore\":" + std::to_string(flashControlBefore)
           : ",\"flashStatusBeforeReadErrorCode\":\"" +
                 jsonEscape(flashBeforeResult.errorCode) + "\"");
  const std::string operationDiagnosticsExtra =
      "\"operation\":\"" + jsonEscape(*operation) + "\",\"pageBufferReused\":" +
      std::string(reuseRequested ? "true" : "false") + flashBeforeDiagnostics;
  if (channel.transport->transportName() == "mock") {
    auto* mock = dynamic_cast<MockCmsisDapTransport*>(channel.transport.get());
    if (mock) mock->prepareFlashAlgorithm(*operation, request.targetAddress, request.size, *data, request.bkptAddress);
  }
  FlashAlgorithmRunResult algorithmResult;
  CortexMDebugDiagnostics operationDiagnostics;
  const Result result = debug.executeFlashAlgorithm(request, algorithmResult, diag,
                                                    std::chrono::milliseconds(*timeout),
                                                    &operationDiagnostics);
  operationDiagnostics.elapsedMs = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count());
  operationDiagnostics.errorCode = result.errorCode;
  if (!result.ok) {
    channel.clearFlashAlgorithmState();
  } else if (request.loadAlgorithmCode) {
    channel.flashAlgorithmLoaded = true;
    channel.flashAlgorithmAddress = request.algorithmAddress;
    channel.flashAlgorithmCode = code.value();
  }
  if (!result.ok) return coreFailure(result, "flashAlgorithm", channel, started, *timeout, diag,
                                     operationDiagnosticsExtra,
                                     &operationDiagnostics);
  std::vector<uint32_t> flashRegisters;
  const Result flashRegisterResult = target.readMemoryBlock(kStm32F4FlashSr, 2, flashRegisters, diag,
                                                            std::chrono::milliseconds(*timeout));
  const bool flashRegistersValid = flashRegisterResult.ok && flashRegisters.size() == 2;
  const uint32_t flashStatus = flashRegistersValid ? flashRegisters[0] : 0;
  const uint32_t flashControl = flashRegistersValid ? flashRegisters[1] : 0;
  const std::string flashAfterDiagnostics =
      ",\"flashStatusValid\":" + std::string(flashRegistersValid ? "true" : "false") +
      (flashRegistersValid
           ? ",\"flashStatus\":" + std::to_string(flashStatus) +
                 ",\"flashControl\":" + std::to_string(flashControl)
           : ",\"flashStatusReadErrorCode\":\"" +
                 jsonEscape(flashRegisterResult.errorCode) + "\"");
  if (!flashRegisterResult.ok) channel.clearFlashPageBuffer();
  const std::string flashDiagnostics = flashBeforeDiagnostics + flashAfterDiagnostics;
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  const std::string dataJson = "{\"operation\":\"" + jsonEscape(*operation) + "\",\"address\":" +
                               std::to_string(request.targetAddress) + ",\"size\":" +
                               std::to_string(request.size) + ",\"returnCode\":" +
                               std::to_string(algorithmResult.returnCode) + ",\"pc\":" +
                               std::to_string(algorithmResult.pc) + ",\"dhcsr\":" +
                               std::to_string(algorithmResult.dhcsr) + flashDiagnostics + "}";
  if (algorithmResult.returnCode != 0) {
    channel.clearFlashAlgorithmState();
    const char* errorCode = algorithmResult.returnCode == 1
                                ? ErrorCodes::kDapAlgorithmTimeout
                                : algorithmResult.returnCode == 2
                                  ? ErrorCodes::kFlashProtectionError
                                  : *operation == "verify"
                                    ? "VerifyFailed"
                                    : ErrorCodes::kDapAlgorithmError;
    operationDiagnostics.errorCode = errorCode;
    std::string message = "Flash Algorithm " + *operation + " returned error code " +
                          std::to_string(algorithmResult.returnCode);
    if (flashRegistersValid) {
      message += " (FLASH_SR=" + hexWord(flashStatus) +
                 " FLASH_CR=" + hexWord(flashControl) + ")";
    }
                    return resultJson(false, message,
                      "Halted", elapsedMs, dataJson, errorCode,
                    cortexDiagnosticsJson("flashAlgorithm", *timeout, diag,
                                          operationDiagnosticsExtra + flashAfterDiagnostics,
                                              &operationDiagnostics));
  }
  if (*operation == "programPage") {
    channel.flashPageBufferValid = true;
    channel.flashPageBufferAddress = request.pageBufferAddress;
    channel.flashPageTargetAddress = request.targetAddress;
    channel.flashPageSize = request.size;
    channel.flashPageData = data.value();
  } else {
    channel.clearFlashPageBuffer();
  }
  return resultJson(true, "Flash Algorithm operation completed", "Halted", elapsedMs, dataJson, "",
                    cortexDiagnosticsJson("flashAlgorithm", *timeout, diag,
                                          operationDiagnosticsExtra + flashAfterDiagnostics,
                                              &operationDiagnostics));
}

std::string coreFailure(const Result& result, const char* operation, Channel& channel,
                        const std::chrono::steady_clock::time_point& started,
                        uint32_t timeoutMs, const DapTransferDiagnostics& diag,
                        const std::string& extra,
                        const CortexMDebugDiagnostics* algorithm) {
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  std::cerr << "[cmsis-dap-helper] control failure operation=" << operation
            << " code="
            << (result.errorCode.empty() ? ErrorCodes::kInternalError : result.errorCode)
            << " message=" << result.message
            << " diagnostics=" << cortexDiagnosticsJson(operation, timeoutMs, diag, extra, algorithm)
            << std::endl;
  return resultJson(false, result.message, channel.state(), elapsedMs, "{}",
                    result.errorCode.empty() ? ErrorCodes::kInternalError : result.errorCode,
                    cortexDiagnosticsJson(operation, timeoutMs, diag, extra, algorithm));
}

std::string invalidControlTimeout(const char* operation, Channel& channel) {
  return resultJson(false, "timeoutMs must be an integer in 1..10000",
                    channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest,
                    "{\"operation\":\"" + std::string(operation) + "\",\"field\":\"timeoutMs\"}");
}

std::string handleCoreGetState(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return coreFailure(readyResult, "getState", channel, started, 0, {});
  }
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("getState", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "getState", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CortexMDebugState state;
  const Result result = debug.getState(state, diag, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "getState", channel, started, *timeout, diag);
  std::string data = "{\"state\":\"" + cortexStateName(state) +
                     "\",\"dhcsr\":" + std::to_string(state.dhcsr);
  if (state.pcValid) data += ",\"pc\":" + std::to_string(state.pc);
  data += "}";
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M state read", cortexStateName(state), elapsedMs, data, "",
                    cortexDiagnosticsJson("getState", *timeout, diag));
}

std::string handleCoreHalt(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) return coreFailure(readyResult, "halt", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("halt", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "halt", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CortexMDebugState state;
  const Result result = debug.halt(state, diag, std::chrono::milliseconds(*timeout));
  if (!result.ok) {
    return coreFailure(result, "halt", channel, started, *timeout, diag,
                       "\"dhcsrWrite\":" +
                           std::to_string(kCoreDebugDbgKey | kCoreDebugCDebugEn |
                                          kCoreDebugCHalt));
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M halt confirmed", cortexStateName(state), elapsedMs,
                    "{\"state\":\"" + cortexStateName(state) + "\",\"dhcsr\":" +
                        std::to_string(state.dhcsr) + ",\"pc\":" + std::to_string(state.pc) + "}",
                    "",
                    cortexDiagnosticsJson("halt", *timeout, diag,
                                          "\"dhcsrWrite\":" +
                                              std::to_string(kCoreDebugDbgKey |
                                                             kCoreDebugCDebugEn |
                                                             kCoreDebugCHalt)));
}

std::string handleCoreRun(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) return coreFailure(readyResult, "run", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("run", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "run", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CortexMDebugState state;
  const Result result = debug.run(state, diag, std::chrono::milliseconds(*timeout));
  if (!result.ok) {
    return coreFailure(result, "run", channel, started, *timeout, diag,
                       "\"dhcsrWrite\":" +
                           std::to_string(kCoreDebugDbgKey | kCoreDebugCDebugEn));
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M run confirmed", cortexStateName(state), elapsedMs,
                    "{\"state\":\"" + cortexStateName(state) + "\",\"dhcsr\":" +
                        std::to_string(state.dhcsr) + "}",
                    "",
                    cortexDiagnosticsJson("run", *timeout, diag,
                                          "\"dhcsrWrite\":" +
                                              std::to_string(kCoreDebugDbgKey |
                                                             kCoreDebugCDebugEn)));
}

std::string handleCoreReset(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) return coreFailure(readyResult, "reset", channel, started, 0, {});
  // SYSRESETREQ may reset or partially reset the SRAM image even when the
  // subsequent state read fails. Never trust a cached algorithm after reset.
  channel.clearFlashAlgorithmState();
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("reset", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "reset", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CortexMDebugState state;
  const Result result = debug.reset(state, diag, std::chrono::milliseconds(*timeout));
  if (!result.ok) {
    return coreFailure(result, "reset", channel, started, *timeout, diag,
                       "\"aircrWrite\":" +
                           std::to_string(kCoreDebugVectKey | kCoreDebugSysResetReq));
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  std::string data = "{\"state\":\"" + cortexStateName(state) +
                     "\",\"dhcsr\":" + std::to_string(state.dhcsr);
  if (state.pcValid) data += ",\"pc\":" + std::to_string(state.pc);
  data += "}";
  return resultJson(true, "Cortex-M reset request confirmed", cortexStateName(state), elapsedMs,
                    data, "",
                    cortexDiagnosticsJson("reset", *timeout, diag,
                                          "\"aircrWrite\":" +
                                              std::to_string(kCoreDebugVectKey |
                                                             kCoreDebugSysResetReq)));
}

std::string handleCoreStepInstruction(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) return coreFailure(readyResult, "stepInstruction", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("stepInstruction", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "stepInstruction", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CortexMDebugStepResult step;
  const Result result =
      debug.stepInstruction(step, diag, std::chrono::milliseconds(*timeout));
  if (!result.ok) {
    return coreFailure(result, "stepInstruction", channel, started, *timeout, diag,
                       "\"dhcsrWrite\":" +
                           std::to_string(kCoreDebugDbgKey | kCoreDebugCDebugEn |
                                          kCoreDebugCStep));
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M instruction step confirmed", "Halted", elapsedMs,
                    "{\"state\":\"Halted\",\"dhcsr\":" + std::to_string(step.dhcsr) +
                        ",\"pcBefore\":" + std::to_string(step.pcBefore) +
                        ",\"pcAfter\":" + std::to_string(step.pcAfter) + "}",
                    "",
                    cortexDiagnosticsJson("stepInstruction", *timeout, diag,
                                          "\"dhcsrWrite\":" +
                                              std::to_string(kCoreDebugDbgKey |
                                                             kCoreDebugCDebugEn |
                                                             kCoreDebugCStep)));
}

std::string handleCoreReadRegister(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) return coreFailure(readyResult, "readRegister", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("readRegister", channel);
  const auto index = uintField(params, "index");
  if (!index || *index > 16) {
    return resultJson(false, "readRegister requires index in 0..16", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest,
                      "{\"operation\":\"readRegister\",\"field\":\"index\"}");
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      target.initializeDebugPower(diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "readRegister", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  uint32_t value = 0;
  const Result result =
      debug.readRegister(static_cast<uint32_t>(*index), value, diag,
                         std::chrono::milliseconds(*timeout));
  if (!result.ok) {
    return coreFailure(result, "readRegister", channel, started, *timeout, diag,
                       "\"register\":" + std::to_string(*index));
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M register read", "Halted", elapsedMs,
                    "{\"register\":" + std::to_string(*index) +
                        ",\"value\":" + std::to_string(value) + "}",
                    "",
                    cortexDiagnosticsJson("readRegister", *timeout, diag,
                                          "\"register\":" + std::to_string(*index)));
}

// ---------------------------------------------------------------------------
// Dispatch loop
// ---------------------------------------------------------------------------

std::string dispatch(const JsonValue& request, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const JsonValue* id = request.get("id");
  const JsonValue* method = request.get("method");
  const JsonValue* params = request.get("params");
  if (!id || id->kind != JsonValue::Kind::Number) {
    return protocolError(jsonSerialize(request), "request.id must be a number");
  }
  if (!method || method->kind != JsonValue::Kind::String) {
    return protocolError(jsonSerialize(request), "request.method must be a string");
  }
  if (!params || params->kind != JsonValue::Kind::Object) {
    return protocolError(jsonSerialize(request), "request.params must be an object");
  }

  std::string result;
  const std::string& name = method->string;
  if (name == "hello") {
    result = handleHello(*params);
  } else if (name == "shutdown") {
    result = handleShutdown();
  } else if (name == "enumDevices") {
    result = handleEnumDevices(*params, channel);
  } else if (name == "open") {
    result = handleOpen(*params, channel);
  } else if (name == "close") {
    result = handleClose(channel);
  } else if (name == "getInfo") {
    result = handleGetInfo(*params, channel);
  } else if (name == "connect") {
    result = handleConnect(*params, channel);
  } else if (name == "disconnect") {
    result = handleDisconnect(channel);
  } else if (name == "dpRead") {
    result = handleDpRead(*params, channel);
  } else if (name == "dpWrite") {
    result = handleDpWrite(*params, channel);
  } else if (name == "apRead") {
    result = handleApRead(*params, channel);
  } else if (name == "apWrite") {
    result = handleApWrite(*params, channel);
  } else if (name == "readMemory") {
    result = handleReadMemory(*params, channel);
  } else if (name == "readMemoryBlock") {
    result = handleReadMemoryBlock(*params, channel);
  } else if (name == "flashAlgorithm") {
    result = handleFlashAlgorithm(*params, channel);
  } else if (name == "getState") {
    result = handleCoreGetState(*params, channel);
  } else if (name == "halt") {
    result = handleCoreHalt(*params, channel);
  } else if (name == "run") {
    result = handleCoreRun(*params, channel);
  } else if (name == "reset") {
    result = handleCoreReset(*params, channel);
  } else if (name == "stepInstruction") {
    result = handleCoreStepInstruction(*params, channel);
  } else if (name == "readRegister") {
    result = handleCoreReadRegister(*params, channel);
  } else {
    const long long elapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    result = resultJson(false, "unknown method: " + name, channel.state(), elapsedMs, "{}",
                        "UnknownMethod", "{\"method\":\"" + jsonEscape(name) + "\"}");
  }
  return responseEnvelope(*id, result);
}

// ---------------------------------------------------------------------------
// Self-test for the overlapped I/O cancellation outcome classification, the
// settled-operation lifecycle invariants, and the transport's owner-loss
// behavior driven through an injected fake I/O seam. Invoked with --selftest
// before the RPC loop; prints one JSON line and exits 0 only when every case
// passes. The pure-function cases classify Windows error codes; the
// instance-level cases drive CmsisDapHidTransport through FakeHidIo. NONE of
// them exercise real Windows overlapped I/O, CancelIoEx or GetOverlappedResult.
// ---------------------------------------------------------------------------

// Scriptable Win32 I/O seam used to verify the transport's owner-loss
// semantics without real hardware. Records whether CancelIoEx /
// GetOverlappedResult / ReadFile / WriteFile were invoked and with which
// handle, so the test can assert that no underlying I/O happens after the
// transport was marked lost.
class FakeHidIo : public HidIo {
 public:
  HANDLE createEvent() override {
    // A fake, unique event handle; the fake wait below treats it as a
    // scripted result, so no real event object is needed.
    ++eventCounter_;
    return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(0x1000 + eventCounter_));
  }

  BOOL cancelIoEx(HANDLE file, OVERLAPPED*, DWORD& lastError) override {
    cancelCalls_++;
    cancelHandle_ = file;
    lastError = cancelError_;
    return cancelResult_;
  }

  BOOL getOverlappedResult(HANDLE, OVERLAPPED*, DWORD& bytesTransferred, BOOL /*wait*/,
                           DWORD& lastError) override {
    gorCalls_++;
    bytesTransferred = gorBytes_;
    lastError = gorError_;
    return gorResult_;
  }

  BOOL readFile(HANDLE file, void*, DWORD, OVERLAPPED*, DWORD& lastError) override {
    readCalls_++;
    readHandle_ = file;
    lastError = readError_;
    return readResult_;
  }

  BOOL writeFile(HANDLE file, const void*, DWORD, OVERLAPPED*, DWORD& lastError) override {
    writeCalls_++;
    writeHandle_ = file;
    lastError = writeError_;
    return writeResult_;
  }

  BOOL closeHandle(HANDLE object) override {
    closeCalls_++;
    lastClosedHandle_ = object;
    // Closing the same fake handle more than once would be a bug.
    return closeSeen_.insert(object).second;
  }

  DWORD waitForSingleObject(HANDLE, DWORD) override { return waitResult_; }

  HANDLE createFile(const wchar_t*) override {
    // A fake, unique device handle so open() succeeds without real hardware.
    return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(0x5000 + eventCounter_));
  }

  BOOL setOutputReport(HANDLE, const void*, DWORD) override {
    setOutputReportCalls_++;
    return setOutputReportResult_;
  }

  int cancelCalls_ = 0;
  int gorCalls_ = 0;
  int readCalls_ = 0;
  int writeCalls_ = 0;
  int closeCalls_ = 0;
  int setOutputReportCalls_ = 0;
  BOOL setOutputReportResult_ = TRUE;
  HANDLE cancelHandle_ = INVALID_HANDLE_VALUE;
  HANDLE readHandle_ = INVALID_HANDLE_VALUE;
  HANDLE writeHandle_ = INVALID_HANDLE_VALUE;
  HANDLE lastClosedHandle_ = INVALID_HANDLE_VALUE;
  std::set<HANDLE> closeSeen_;
  BOOL cancelResult_ = TRUE;
  DWORD cancelError_ = ERROR_SUCCESS;
  BOOL gorResult_ = FALSE;
  DWORD gorError_ = ERROR_SUCCESS;
  DWORD gorBytes_ = 0;
  BOOL readResult_ = FALSE;
  DWORD readError_ = ERROR_DEVICE_REMOVED;
  BOOL writeResult_ = FALSE;
  DWORD writeError_ = ERROR_DEVICE_REMOVED;
  DWORD waitResult_ = WAIT_TIMEOUT;  // force the settle path on every I/O
  int eventCounter_ = 0;
};

// Scriptable wire transport used by the DAP-03 raw-frame golden tests. It
// records every command the production protocol layer writes to the wire (for
// golden REQUEST assertions) and replays one hardcoded response frame per
// request (for golden RESPONSE assertions). The golden frames spell out the
// official CMSIS-DAP layouts literally - 0x05/0x06 command ids, the Transfer
// Request bit positions, 16-bit little-endian counts, and the response
// status/data offsets - so they depend on neither the production constants
// (cmsis_dap_protocol.h) nor the mock oracle (mock_transport.h).
class ScriptedTransport : public CmsisDapTransport {
 public:
  std::string transportName() const override { return "scripted"; }
  Result enumerate(const DeviceSelector&, std::vector<DeviceDescriptor>& out) override {
    out.clear();
    return Result::success();
  }
  Result open(const DeviceDescriptor&) override { return Result::success(); }
  Result close() override { return Result::success(); }
  bool isOpen() const override { return true; }
  Result writePacket(const uint8_t* data, size_t length,
                     std::chrono::milliseconds /*timeout*/) override {
    ++writeCalls;
    lastRequest.assign(data, data + length);
    requests.emplace_back(data, data + length);
    return Result::success();
  }
  Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                    std::chrono::milliseconds /*timeout*/) override {
    if (scriptedResponses.empty() && scripted.empty()) {
      return Result::error(ErrorCodes::kReadTimeout, "no scripted response queued");
    }
    const std::vector<uint8_t>& response = scriptedResponses.empty()
                                               ? scripted
                                               : scriptedResponses.front();
    if (response.size() > capacity) {
      return Result::error(ErrorCodes::kMalformedResponse, "scripted response exceeds capacity");
    }
    std::memcpy(data, response.data(), response.size());
    length = response.size();
    if (scriptedResponses.empty()) {
      scripted.clear();
    } else {
      scriptedResponses.pop_front();
    }
    return Result::success();
  }
  Result drainInput(std::chrono::milliseconds /*timeout*/) override { return Result::success(); }
  size_t payloadCapacity() const override { return 64; }
  bool deviceLost() const override { return false; }

  std::vector<uint8_t> lastRequest;
  std::vector<std::vector<uint8_t>> requests;
  std::vector<uint8_t> scripted;
  std::deque<std::vector<uint8_t>> scriptedResponses;
  int writeCalls = 0;
};

int runSelfTest() {
  int failures = 0;
  auto expect = [&failures](bool ok, const char* name) {
    if (!ok) {
      ++failures;
      std::cout << "{\"selftest\":\"fail\",\"case\":\"" << name << "\"}\n";
    }
  };
  expect(!rawTraceEnabledForValue(nullptr) &&
             !rawTraceEnabledForValue("") &&
             !rawTraceEnabledForValue("0") &&
             rawTraceEnabledForValue("1"),
         "raw-trace-is-explicit-opt-in");
  // --- write outcome classification ---
  // 1. Cancellation confirmed (ERROR_OPERATION_ABORTED) -> resend is allowed.
  expect(classifyWriteOutcome(true, ERROR_SUCCESS, WAIT_OBJECT_0, false,
                              ERROR_OPERATION_ABORTED) == WriteOutcome::Cancelled,
         "cancel-confirmed");
  // CancelIoEx with ERROR_NOT_FOUND must not be taken as cancellation; the
  // GetOverlappedResult verdict (ABORTED) decides.
  expect(classifyWriteOutcome(false, ERROR_NOT_FOUND, WAIT_OBJECT_0, false,
                              ERROR_OPERATION_ABORTED) == WriteOutcome::Cancelled,
         "cancel-confirmed-after-not-found");
  // 2. The original write COMPLETED -> it was sent; resend is forbidden.
  expect(classifyWriteOutcome(true, ERROR_SUCCESS, WAIT_OBJECT_0, true,
                              ERROR_SUCCESS) == WriteOutcome::CompletedLate,
         "completed-late");
  // ERROR_NOT_FOUND with a completed GetOverlappedResult means the write went
  // out; never treat NOT_FOUND as "cancelled".
  expect(classifyWriteOutcome(false, ERROR_NOT_FOUND, WAIT_OBJECT_0, true,
                              ERROR_SUCCESS) == WriteOutcome::CompletedLate,
         "completed-late-after-not-found");
  // 3. Unknown outcome -> resend is forbidden.
  expect(classifyWriteOutcome(true, ERROR_SUCCESS, WAIT_TIMEOUT, false,
                              ERROR_IO_INCOMPLETE) == WriteOutcome::Unknown,
         "outcome-unknown-timeout");
  expect(classifyWriteOutcome(false, ERROR_NOT_FOUND, WAIT_TIMEOUT, false,
                              ERROR_IO_INCOMPLETE) == WriteOutcome::Unknown,
         "outcome-unknown-not-found");

  // --- settled-operation lifecycle invariants (after GetOverlappedResult
  // reported a terminal state, so the OVERLAPPED/buffer may be released) ---
  // ERROR_IO_INCOMPLETE is the ONLY "still in flight" state: the kernel may
  // still touch the OVERLAPPED and the buffer. Settling must not end on it.
  expect(isIoInFlight(ERROR_IO_INCOMPLETE), "in-flight-is-io-incomplete");
  expect(!isIoInFlight(ERROR_OPERATION_ABORTED), "aborted-is-not-in-flight");
  expect(!isIoInFlight(ERROR_SUCCESS), "success-is-not-in-flight");
  expect(!isIoInFlight(ERROR_DEVICE_REMOVED), "device-removed-is-not-in-flight");
  // A settled, completed operation is CompletedLate (the write was sent).
  expect(decideSettledOutcome(true, ERROR_SUCCESS) == WriteOutcome::CompletedLate,
         "settled-completed");
  // A settled, aborted operation is Cancelled (safe to resend once).
  expect(decideSettledOutcome(false, ERROR_OPERATION_ABORTED) == WriteOutcome::Cancelled,
         "settled-aborted");
  // Any other settled outcome (device removed, ...) is Unknown: the operation
  // is provably finished so the memory may be released, but the command must
  // never be resent.
  expect(decideSettledOutcome(false, ERROR_DEVICE_REMOVED) == WriteOutcome::Unknown,
         "settled-device-removed");
  expect(decideSettledOutcome(false, ERROR_NOT_FOUND) == WriteOutcome::Unknown,
         "settled-not-found-not-cancelled");

  // --- instance-level owner-loss behavior (driven through the fake I/O
  // seam; still no real Windows overlapped I/O) ---
  // The fake events always time out, so every read/write enters the settle
  // path (CancelIoEx + GetOverlappedResult). That is the path that must mark
  // the transport lost on a device-loss terminal error.
  {
    FakeHidIo io;
    CmsisDapHidTransport transport(&io);
    DeviceDescriptor device;
    device.path = "MOCK\\FAKE";
    device.vid = "1234";
    device.pid = "5678";
    device.inputReportLength = 65;
    device.outputReportLength = 65;
    expect(transport.open(device).ok, "open-fake-device");

    // Terminal ERROR_DEVICE_REMOVED while settling a timed-out WRITE:
    //  - writePacket must fail with DeviceRemoved
    //  - the transport must be marked lost
    //  - the handle must be closed
    //  - a later write/read must NOT invoke any underlying I/O (the early
    //    lost_ guard returns DeviceRemoved before touching the handle).
    io.writeResult_ = TRUE;
    io.writeError_ = ERROR_SUCCESS;  // WriteFile pends
    io.gorResult_ = FALSE;
    io.gorError_ = ERROR_DEVICE_REMOVED;  // settle: device lost
    const uint8_t payload[] = {0x02, 0x01};
    const Result deviceRemovedWrite = transport.writePacket(payload, sizeof(payload),
                                                            std::chrono::milliseconds(1));
    expect(!deviceRemovedWrite.ok &&
               deviceRemovedWrite.errorCode == ErrorCodes::kDeviceRemoved,
           "write-settle-device-removed-returns-device-removed");
    expect(transport.deviceLost(), "write-settle-device-removed-marks-lost");
    expect(!transport.isOpen(), "write-settle-device-removed-closes-handle");
    const int writeCallsAfterLost = io.writeCalls_;
    const int readCallsAfterLost = io.readCalls_;
    const Result laterWrite = transport.writePacket(payload, sizeof(payload),
                                                    std::chrono::milliseconds(1));
    expect(!laterWrite.ok && laterWrite.errorCode == ErrorCodes::kDeviceRemoved,
           "write-after-lost-returns-device-removed");
    uint8_t buffer[64] = {};
    size_t length = 0;
    const Result laterRead = transport.readPacket(buffer, sizeof(buffer), length,
                                                  std::chrono::milliseconds(1));
    expect(!laterRead.ok && laterRead.errorCode == ErrorCodes::kDeviceRemoved,
           "read-after-lost-returns-device-removed");
    expect(io.writeCalls_ == writeCallsAfterLost,
           "no-write-io-after-lost");
    expect(io.readCalls_ == readCallsAfterLost,
           "no-read-io-after-lost");
  }

  {
    // Terminal ERROR_DEVICE_REMOVED while settling a timed-out READ behaves
    // identically: DeviceRemoved, lost, handle closed, no further I/O.
    FakeHidIo io;
    CmsisDapHidTransport transport(&io);
    DeviceDescriptor device;
    device.path = "MOCK\\FAKE";
    device.vid = "1234";
    device.pid = "5678";
    device.inputReportLength = 65;
    device.outputReportLength = 65;
    expect(transport.open(device).ok, "open-fake-device-read");
    io.readResult_ = TRUE;
    io.readError_ = ERROR_SUCCESS;  // ReadFile pends
    io.gorResult_ = FALSE;
    io.gorError_ = ERROR_DEVICE_REMOVED;  // settle: device lost
    uint8_t buffer[64] = {};
    size_t length = 0;
    const Result deviceRemovedRead = transport.readPacket(buffer, sizeof(buffer), length,
                                                          std::chrono::milliseconds(1));
    expect(!deviceRemovedRead.ok &&
               deviceRemovedRead.errorCode == ErrorCodes::kDeviceRemoved,
           "read-settle-device-removed-returns-device-removed");
    expect(transport.deviceLost(), "read-settle-device-removed-marks-lost");
    expect(!transport.isOpen(), "read-settle-device-removed-closes-handle");
    const int readCallsAfterLost = io.readCalls_;
    const Result laterRead = transport.readPacket(buffer, sizeof(buffer), length,
                                                  std::chrono::milliseconds(1));
    expect(!laterRead.ok && laterRead.errorCode == ErrorCodes::kDeviceRemoved,
           "read-after-lost-read-path-returns-device-removed");
    expect(io.readCalls_ == readCallsAfterLost,
           "no-read-io-after-lost-read-path");
  }

  {
    // ERROR_OPERATION_ABORTED settle on a WRITE: cancellation confirmed, the
    // same command may be resent exactly once through the control-transfer
    // path (HidD_SetOutputReport), and the transport stays open (NOT lost).
    FakeHidIo io;
    CmsisDapHidTransport transport(&io);
    DeviceDescriptor device;
    device.path = "MOCK\\FAKE";
    device.vid = "1234";
    device.pid = "5678";
    device.inputReportLength = 65;
    device.outputReportLength = 65;
    expect(transport.open(device).ok, "open-fake-device-abort");
    io.writeResult_ = TRUE;
    io.writeError_ = ERROR_SUCCESS;  // WriteFile pends
    io.gorResult_ = FALSE;
    io.gorError_ = ERROR_OPERATION_ABORTED;  // settle: cancellation confirmed
    io.setOutputReportResult_ = TRUE;        // the single resend succeeds
    const uint8_t payload[] = {0x02, 0x01};
    const Result cancelledWrite = transport.writePacket(payload, sizeof(payload),
                                                        std::chrono::milliseconds(1));
    expect(cancelledWrite.ok, "write-settle-aborted-resend-succeeds");
    expect(io.setOutputReportCalls_ == 1, "write-settle-aborted-resend-exactly-once");
    expect(!transport.deviceLost(), "write-settle-aborted-not-lost");
    expect(transport.isOpen(), "write-settle-aborted-stays-open");
  }

  {
    // CompletedLate settle on a WRITE: the write was sent, resend is
    // forbidden, the session stays usable.
    FakeHidIo io;
    CmsisDapHidTransport transport(&io);
    DeviceDescriptor device;
    device.path = "MOCK\\FAKE";
    device.vid = "1234";
    device.pid = "5678";
    device.inputReportLength = 65;
    device.outputReportLength = 65;
    expect(transport.open(device).ok, "open-fake-device-completed");
    io.writeResult_ = TRUE;
    io.writeError_ = ERROR_SUCCESS;  // WriteFile pends
    io.gorResult_ = TRUE;  // settle: completed late
    io.gorError_ = ERROR_SUCCESS;
    io.gorBytes_ = 2;
    const uint8_t payload[] = {0x02, 0x01};
    const Result completedLateWrite = transport.writePacket(payload, sizeof(payload),
                                                            std::chrono::milliseconds(1));
    expect(!completedLateWrite.ok &&
               completedLateWrite.errorCode == ErrorCodes::kWriteCompletedLate,
           "write-settle-completed-late-is-write-completed-late");
    expect(!transport.deviceLost(), "write-settle-completed-late-not-lost");
    expect(transport.isOpen(), "write-settle-completed-late-stays-open");
  }

  {
    // Unknown settle on a WRITE (e.g. ERROR_CRC, not a device-loss code):
    // never resent, session NOT lost (the handle may still be valid).
    FakeHidIo io;
    CmsisDapHidTransport transport(&io);
    DeviceDescriptor device;
    device.path = "MOCK\\FAKE";
    device.vid = "1234";
    device.pid = "5678";
    device.inputReportLength = 65;
    device.outputReportLength = 65;
    expect(transport.open(device).ok, "open-fake-device-unknown");
    io.writeResult_ = TRUE;
    io.writeError_ = ERROR_SUCCESS;  // WriteFile pends
    io.gorResult_ = FALSE;
    io.gorError_ = ERROR_CRC;  // settle: unknown, not a device-loss code
    const uint8_t payload[] = {0x02, 0x01};
    const Result unknownWrite = transport.writePacket(payload, sizeof(payload),
                                                      std::chrono::milliseconds(1));
    expect(!unknownWrite.ok &&
               unknownWrite.errorCode == ErrorCodes::kRequestCancelled,
           "write-settle-unknown-is-request-cancelled");
    expect(!transport.deviceLost(), "write-settle-unknown-not-lost");
    expect(transport.isOpen(), "write-settle-unknown-stays-open");
    expect(io.setOutputReportCalls_ == 0, "write-settle-unknown-never-resent");
  }

  // --- DAP-03: DP/AP protocol and target layer against the in-memory mock
  // SWD target. These cases need no real USB device and no JSON-RPC round
  // trip: they drive CmsisDapProtocol + CmsisDapTarget directly. ---
  auto openMock = [](const char* vid, const char* pid,
                     MockCmsisDapTransport& mock) -> bool {
    DeviceSelector selector;
    selector.vid = vid;
    selector.pid = pid;
    std::vector<DeviceDescriptor> devices;
    if (!mock.enumerate(selector, devices).ok || devices.empty()) return false;
    return mock.open(devices.front()).ok;
  };
  auto readLe32Local = [](const std::vector<uint8_t>& bytes, size_t offset) -> uint32_t {
    return static_cast<uint32_t>(bytes[offset]) |
           (static_cast<uint32_t>(bytes[offset + 1]) << 8) |
           (static_cast<uint32_t>(bytes[offset + 2]) << 16) |
           (static_cast<uint32_t>(bytes[offset + 3]) << 24);
  };

  {
    // ADIv5 pipeline regression: after [AP DRW read][DP RDBUFF] consumes the
    // word at TAR, a following block read must begin at the auto-incremented
    // TAR rather than replaying the consumed word.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-pipeline-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    expect(target.writeAp(kApRegCsw, kApCsw32Auto, diag).ok,
           "dap03-pipeline-csw");
    expect(target.writeAp(kApRegTar, kMockRamBase, diag).ok,
           "dap03-pipeline-tar");

    uint32_t first = 0;
    const Result dummy = target.readAp(kApRegDrw, first, diag);
    expect(dummy.ok && first == mockWordAt(kMockRamBase),
           "dap03-pipeline-rdbuff-first-word");

    std::vector<uint32_t> nextWords;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result block = protocol.dapTransferBlockRead(
        0, 0x0F, 2, nextWords, ack, completed, std::chrono::milliseconds(200));
    expect(block.ok && nextWords.size() == 2 && completed == 2,
           "dap03-pipeline-block-read");
    if (block.ok && nextWords.size() == 2) {
      expect(nextWords[0] == mockWordAt(kMockRamBase + 4) &&
                 nextWords[1] == mockWordAt(kMockRamBase + 8),
             "dap03-pipeline-does-not-replay-rdbuff-word");
    }
  }

  {
    // Independent vector-table evidence: readMemoryBlock must return each
    // hard-coded flash word exactly once, including the initial SRAM SP.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-vector-block-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> words;
    const Result result = target.readMemoryBlock(kMockFlashBase, 4, words, diag);
    const std::vector<uint32_t> expected = {
        kMockFlashVectorWord0, kMockFlashVectorWord1,
        kMockFlashVectorWord2, kMockFlashVectorWord3};
    expect(result.ok && words == expected, "dap03-vector-block-exact-words");
    expect(diag.chunks == 1 && diag.blockReads == 1 && diag.packets == 2,
           "dap03-vector-block-batched-setup-diagnostics");
    expect(mock.injection().blockReadCount == 1 &&
               mock.lastBlockRequest() == std::vector<uint8_t>({0x06, 0x00, 0x03, 0x00, 0x0F}),
           "dap03-vector-block-requests-chunk-minus-one");
  }

  {
    // A one-word chunk is completed by the dummy/RDBUFF read alone; no block
    // command may be sent for it.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-vector-single-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> words;
    const Result result = target.readMemoryBlock(kMockFlashBase, 1, words, diag);
    expect(result.ok && words == std::vector<uint32_t>({kMockFlashVectorWord0}),
           "dap03-vector-single-word");
    expect(diag.chunks == 1 && diag.blockReads == 0 && diag.packets == 1 &&
               mock.injection().blockReadCount == 0,
           "dap03-vector-single-batched-setup-no-block-request");
  }

  {
    // Independent byte-oriented evidence: the first two words must be the
    // vector-table SP and Reset_Handler, not word1 and word2.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-vector-bytes-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(kMockFlashBase, 8, bytes, diag);
    expect(result.ok && bytes.size() == 8 && readLe32Local(bytes, 0) == 0x20006FA8u &&
               readLe32Local(bytes, 4) == 0x080001C1u,
           "dap03-vector-byte-read-first-two-words");
  }

  {
    // Normal target: IDCODE, aligned 4-byte read, 1-byte read, cross-1 KiB
    // boundary read, cross-packet read, and block read.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-open-normal");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    uint32_t idcode = 0;
    expect(target.readDp(kDpRegAbortIdcode, idcode, diag).ok && idcode == 0x2BA01477u,
           "dap03-idcode");
    std::vector<uint8_t> bytes;
    diag = DapTransferDiagnostics{};
    const Result read4 = target.readMemory(0x20000000, 4, bytes, diag);
    expect(read4.ok && bytes.size() == 4, "dap03-read-4-bytes");
    if (read4.ok) {
      for (size_t i = 0; i < 4; ++i) {
        expect(bytes[i] == mockByteAt(0x20000000 + static_cast<uint32_t>(i)),
               "dap03-read-4-byte-lane");
      }
    }
    bytes.clear();
    diag = DapTransferDiagnostics{};
    const Result read1 = target.readMemory(0x20000003, 1, bytes, diag);
    expect(read1.ok && bytes.size() == 1 && bytes[0] == mockByteAt(0x20000003),
           "dap03-read-1-byte-unaligned");
    bytes.clear();
    diag = DapTransferDiagnostics{};
    const Result readUnaligned = target.readMemory(0x20000001, 7, bytes, diag);
    expect(readUnaligned.ok && bytes.size() == 7, "dap03-read-multi-byte-unaligned");
    if (readUnaligned.ok) {
      for (size_t i = 0; i < bytes.size(); ++i) {
        expect(bytes[i] == mockByteAt(0x20000001 + static_cast<uint32_t>(i)),
               "dap03-read-multi-byte-unaligned-lane");
      }
    }
    bytes.clear();
    diag = DapTransferDiagnostics{};
    const Result crossBoundary = target.readMemory(0x20000FFC, 8, bytes, diag);
    expect(crossBoundary.ok && bytes.size() == 8 && diag.chunks == 2,
           "dap03-cross-1kb-boundary-chunks");
    if (crossBoundary.ok) {
      for (size_t i = 0; i < 8; ++i) {
        expect(bytes[i] == mockByteAt(0x20000FFC + static_cast<uint32_t>(i)),
               "dap03-cross-1kb-byte-lane");
      }
    }
    bytes.clear();
    diag = DapTransferDiagnostics{};
    const Result crossPacket = target.readMemory(0x20000000, 512, bytes, diag);
    expect(crossPacket.ok && bytes.size() == 512 && diag.chunks == 9 &&
               diag.blockReads == 9 && diag.packets == 18,
           "dap03-cross-packet-batched-setup-chunks");
    if (crossPacket.ok) {
      for (uint32_t i = 0; i < 512; ++i) {
        if (bytes[i] != mockByteAt(0x20000000 + i)) {
          expect(false, "dap03-cross-packet-byte-lane");
          break;
        }
      }
    }
    std::vector<uint32_t> words;
    diag = DapTransferDiagnostics{};
    const Result block = target.readMemoryBlock(0x20000100, 16, words, diag);
    expect(block.ok && words.size() == 16 && diag.blockReads == 1,
           "dap03-block-read-chunking");
    if (block.ok) {
      for (uint32_t i = 0; i < 16; ++i) {
        if (words[i] != mockWordAt(0x20000100 + i * 4)) {
          expect(false, "dap03-block-read-values");
          break;
        }
      }
    }
    std::vector<uint32_t> writeWords(32);
    for (uint32_t i = 0; i < writeWords.size(); ++i) writeWords[i] = 0xA5000000u | i;
    diag = DapTransferDiagnostics{};
    const Result writeBlock = target.writeMemoryBlock(0x20000200, writeWords, diag);
    expect(writeBlock.ok && diag.blockWrites == 3 && diag.packets == 4,
           "dap03-block-write-reuses-contiguous-tar");
  }

  {
    // Wait-once target: the first two DRW accesses WAIT; the chunk retry must
    // recover and the retry count must be recorded.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "567F", mock), "dap03-open-wait-once");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(0x20000000, 4, bytes, diag);
    expect(result.ok && bytes.size() == 4, "dap03-wait-once-recovers");
    expect(diag.waitRetries == 2, "dap03-wait-once-retry-count");
    if (result.ok && !bytes.empty()) {
      expect(bytes[0] == mockByteAt(0x20000000), "dap03-wait-once-value");
    }
  }

  {
    // Fault-once target: the first DRW access FAULTs and sets STICKYERR; the
    // target must clear the sticky error through DP ABORT before retrying.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5680", mock), "dap03-open-fault-once");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(0x20000000, 4, bytes, diag);
    expect(result.ok && bytes.size() == 4, "dap03-fault-once-recovers");
    expect(diag.faultClears >= 1, "dap03-fault-cleared-via-abort");
    expect((mock.targetState().dpCtrlStat & kCtrlStatStickyErr) == 0,
           "dap03-fault-sticky-flag-cleared");
  }

  {
    // No-ack target: NO_ACK is a protocol break and fails immediately.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5681", mock), "dap03-open-no-ack");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(0x20000000, 4, bytes, diag);
    expect(!result.ok && result.errorCode == ErrorCodes::kDapAckNoAck,
           "dap03-no-ack-direct-failure");
  }

  {
    // Busy target: WAIT retries are bounded and the budget is recorded.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5683", mock), "dap03-open-busy");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(0x20000000, 4, bytes, diag);
    expect(!result.ok && result.errorCode == ErrorCodes::kDapAckWait,
           "dap03-busy-wait-exhausted");
    expect(diag.waitRetries == kMaxTransferRetries, "dap03-busy-retry-budget");
  }

  {
    // Malformed target: an inconsistent transfer count is a truncated
    // protocol response and must fail without any retry.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5682", mock), "dap03-open-malformed");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(0x20000000, 4, bytes, diag);
    expect(!result.ok && result.errorCode == ErrorCodes::kMalformedResponse,
           "dap03-malformed-response-rejected");
  }

  {
    // Removal target: the device disappears mid-transfer; every subsequent
    // access fails with DeviceRemoved.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5685", mock), "dap03-open-removal");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result first = target.readMemory(0x20000000, 4, bytes, diag);
    expect(!first.ok && first.errorCode == ErrorCodes::kDeviceRemoved,
           "dap03-removal-during-transfer");
    bytes.clear();
    const Result second = target.readMemory(0x20000000, 4, bytes, diag);
    expect(!second.ok && second.errorCode == ErrorCodes::kDeviceRemoved,
           "dap03-removal-after-loss");
    expect(mock.deviceLost(), "dap03-removal-marks-lost");
  }

  {
    // Silent target: a transfer whose response never arrives fails with
    // ReadTimeout and is never guessed to have succeeded.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "567B", mock), "dap03-open-silent");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result result = target.readMemory(0x20000000, 4, bytes, diag);
    expect(!result.ok && result.errorCode == ErrorCodes::kReadTimeout,
           "dap03-transfer-read-timeout");
  }

  {
    // Protocol request validation: a zero-count transfer and an oversized
    // transfer request are rejected before any I/O.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-open-validation");
    CmsisDapProtocol protocol(&mock);
    std::vector<DapTransferItem> empty;
    const Result zeroCount =
        protocol.dapTransfer(0, empty, std::chrono::milliseconds(100));
    expect(!zeroCount.ok && zeroCount.errorCode == ErrorCodes::kDapInvalidRequest,
           "dap03-transfer-zero-count-rejected");
    std::vector<DapTransferItem> tooMany(64);  // 64 write items: 3 + 64*5 > 64
    for (size_t i = 0; i < tooMany.size(); ++i) {
      tooMany[i].ap = false;
      tooMany[i].rnw = false;
      tooMany[i].value = 0;
    }
    const Result oversized =
        protocol.dapTransfer(0, tooMany, std::chrono::milliseconds(100));
    expect(!oversized.ok && oversized.errorCode == ErrorCodes::kPacketTooLarge,
           "dap03-transfer-oversized-rejected");
  }

  {
    // Write-unknown target: a block write whose reply is malformed has an
    // unknown completion state and must NEVER be retried. The write itself
    // may still have landed; the mock counts the write commands.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5684", mock), "dap03-open-write-unknown");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    const std::vector<uint32_t> words = {0xDEADBEEFu, 0xCAFEBABEu};
    const Result write = target.writeMemoryBlock(0x20000000, words, diag);
    expect(!write.ok && write.errorCode == ErrorCodes::kMalformedResponse,
           "dap03-write-unknown-fails");
    expect(mock.injection().blockWriteCount == 1, "dap03-write-unknown-never-retried");
    std::vector<uint8_t> bytes;
    DapTransferDiagnostics readDiag;
    const Result readBack = target.readMemory(0x20000000, 8, bytes, readDiag);
    expect(readBack.ok && bytes.size() == 8, "dap03-write-unknown-readback");
    if (readBack.ok && bytes.size() == 8) {
      expect(readLe32Local(bytes, 0) == 0xDEADBEEFu && readLe32Local(bytes, 4) == 0xCAFEBABEu,
             "dap03-write-unknown-write-landed");
    }
  }

  // --- DAP-03 wire protocol: raw-frame golden tests. Every frame below is
  // spelled out literally against the official CMSIS-DAP layouts
  // (group__DAP__Transfer.html / group__DAP__TransferBlock.html): command ids
  // 0x05/0x06, Transfer Request bits (bit0 APnDP, bit1 RnW, bits 3:2 A[3:2]),
  // 16-bit little-endian counts, and the response [count][status][data]
  // offsets. The ScriptedTransport makes the production request bytes and the
  // scripted response bytes visible, so these tests are independent of both
  // the production constants and the mock oracle. ---
  auto goldenLe32 = [](uint32_t value) -> std::vector<uint8_t> {
    return {static_cast<uint8_t>(value & 0xFF), static_cast<uint8_t>((value >> 8) & 0xFF),
            static_cast<uint8_t>((value >> 16) & 0xFF), static_cast<uint8_t>((value >> 24) & 0xFF)};
  };
  auto goldenItem = [](DapTransferItem& item, bool ap, bool rnw, uint8_t addr) {
    item.ap = ap;
    item.rnw = rnw;
    item.addr = addr;
  };
  auto runScriptedTransfer =
      [&goldenItem](std::vector<uint8_t> scripted, bool ap, bool rnw, uint8_t addr,
                    std::vector<DapTransferItem>& items, ScriptedTransport& transport) -> Result {
    transport.scripted = std::move(scripted);
    CmsisDapProtocol protocol(&transport);
    items.assign(1, DapTransferItem{});
    goldenItem(items[0], ap, rnw, addr);
    return protocol.dapTransfer(0, items, std::chrono::milliseconds(200));
  };

  {
    // Golden: DP IDCODE raw frame. Request must be exactly
    // [0x05][dap=0][count=1][Request=0x02] (APnDP=0, RnW=1, A[3:2]=00).
    // Response [0x05][count=1][status=OK(0x01)][IDCODE LE32].
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r =
        runScriptedTransfer({0x05, 0x01, 0x01, 0x77, 0x14, 0xA0, 0x2B}, false, true, 0, items, t);
    expect(r.ok, "golden-dp-idcode-ok");
    expect(t.lastRequest == std::vector<uint8_t>({0x05, 0x00, 0x01, 0x02}),
           "golden-dp-idcode-request");
    expect(items[0].readDataValid && items[0].readData == 0x2BA01477u,
           "golden-dp-idcode-data");
  }

  {
    // Golden: AP DRW read request bits. Request must be
    // [0x05][dap=0][count=1][Request=0x0F] = APnDP(0x01) | RnW(0x02) |
    // A[3:2]=DRW(3) => (3 << 2) = 0x0C.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r =
        runScriptedTransfer({0x05, 0x01, 0x01, 0x34, 0x12, 0x00, 0x00}, true, true, 3, items, t);
    expect(r.ok, "golden-ap-drw-read-ok");
    expect(t.lastRequest == std::vector<uint8_t>({0x05, 0x00, 0x01, 0x0F}),
           "golden-ap-drw-read-request");
    expect(items[0].readData == 0x1234u, "golden-ap-drw-read-data");
  }

  {
    // Golden: single status byte + read data offset in a 2-item batch
    // [DP IDCODE read][AP DRW read]: request headers 0x02, 0x0F; response
    // [0x05][count=2][status=OK][data0][data1] - the status sits at offset 2
    // and read data starts at offset 3.
    ScriptedTransport t;
    const std::vector<uint8_t> data0 = goldenLe32(0x11111111u);
    const std::vector<uint8_t> data1 = goldenLe32(0x22222222u);
    t.scripted = {0x05, 0x02, 0x01};
    t.scripted.insert(t.scripted.end(), data0.begin(), data0.end());
    t.scripted.insert(t.scripted.end(), data1.begin(), data1.end());
    CmsisDapProtocol protocol(&t);
    std::vector<DapTransferItem> items(2);
    goldenItem(items[0], false, true, 0);
    goldenItem(items[1], true, true, 3);
    const Result r = protocol.dapTransfer(0, items, std::chrono::milliseconds(200));
    expect(r.ok, "golden-batch-single-status-ok");
    expect(t.lastRequest == std::vector<uint8_t>({0x05, 0x00, 0x02, 0x02, 0x0F}),
           "golden-batch-request");
    expect(items[0].readData == 0x11111111u && items[1].readData == 0x22222222u,
           "golden-batch-data-offset");
    expect(items[0].ack == 0x01 && items[1].ack == 0x01, "golden-batch-status-byte");
  }

  {
    // Golden: WAIT partial completion. Response count (1) below requested (2)
    // with status WAIT: the executed item's data is present and trusted, the
    // call fails with DapAckWait, and the later item stays untrusted.
    ScriptedTransport t;
    t.scripted = {0x05, 0x01, 0x02, 0xEF, 0xBE, 0xAD, 0xDE};
    CmsisDapProtocol protocol(&t);
    std::vector<DapTransferItem> items(2);
    goldenItem(items[0], false, true, 0);
    goldenItem(items[1], true, true, 3);
    const Result r = protocol.dapTransfer(0, items, std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kDapAckWait, "golden-wait-partial");
    expect(items[0].readDataValid && items[0].readData == 0xDEADBEEFu,
           "golden-wait-executed-data-trusted");
    expect(!items[1].readDataValid, "golden-wait-later-item-not-trusted");
  }

  {
    // Golden: FAULT partial completion (count 1 of 2, status 0x04).
    ScriptedTransport t;
    t.scripted = {0x05, 0x01, 0x04, 0xEF, 0xBE, 0xAD, 0xDE};
    CmsisDapProtocol protocol(&t);
    std::vector<DapTransferItem> items(2);
    goldenItem(items[0], false, true, 0);
    goldenItem(items[1], true, true, 3);
    const Result r = protocol.dapTransfer(0, items, std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kDapAckFault, "golden-fault-partial");
    expect(!items[1].readDataValid, "golden-fault-later-item-not-trusted");
  }

  {
    // Golden: NO_ACK partial completion (status 0x07) fails directly.
    ScriptedTransport t;
    t.scripted = {0x05, 0x01, 0x07, 0xEF, 0xBE, 0xAD, 0xDE};
    CmsisDapProtocol protocol(&t);
    std::vector<DapTransferItem> items(2);
    goldenItem(items[0], false, true, 0);
    goldenItem(items[1], true, true, 3);
    const Result r = protocol.dapTransfer(0, items, std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kDapAckNoAck, "golden-no-ack-partial");
  }

  {
    // Golden: protocol error bit (status 0x09 = OK | bit3) is reported
    // explicitly, never swallowed into the data.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x09, 0xEF, 0xBE, 0xAD, 0xDE},
                                         false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kProtocolError, "golden-protocol-error-bit");
  }

  {
    // Golden: value mismatch bit (status 0x11) is reported explicitly.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x11, 0xEF, 0xBE, 0xAD, 0xDE},
                                         false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kProtocolError, "golden-mismatch-bit");
  }

  {
    // Golden: response count exceeding the requested count is rejected.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r =
        runScriptedTransfer({0x05, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00}, false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-count-over-request");
  }

  {
    // Golden: truncated read data (declares 2 executed reads, carries 1 word)
    // is rejected as malformed.
    ScriptedTransport t;
    t.scripted = {0x05, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00};
    CmsisDapProtocol protocol(&t);
    std::vector<DapTransferItem> items(2);
    goldenItem(items[0], false, true, 0);
    goldenItem(items[1], true, true, 3);
    const Result r = protocol.dapTransfer(0, items, std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse, "golden-truncated-data");
  }

  {
    // Golden: trailing bytes after the declared read data are HID report
    // padding (the real firmware pads every input report to the full report
    // length with stale bytes) and must be accepted, never rejected. The
    // declared count and status stay authoritative; only a response SHORTER
    // than its declared data is truncated.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0xAA},
                                         false, true, 0, items, t);
    expect(r.ok, "golden-trailing-padding-accepted");
    expect(items[0].readDataValid && items[0].readData == 0x00000001u,
           "golden-trailing-padding-data");
  }

  {
    // Golden: an invalid status byte (0x03 is not a defined ACK) is rejected.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x03, 0x01, 0x00, 0x00, 0x00},
                                         false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse, "golden-invalid-status");
  }

  {
    // Golden: block read request is [0x06][dap=0][count16 LE=3][0x0F]; the
    // response carries count16 LE at bytes 1..2, the status at byte 3 and the
    // read data after it.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0xA5A5A5A5u);
    t.scripted = {0x06, 0x03, 0x00, 0x01};
    for (int i = 0; i < 3; ++i) t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r =
        protocol.dapTransferBlockRead(0, 0x0F, 3, values, ack, completed,
                                      std::chrono::milliseconds(200));
    expect(r.ok && values.size() == 3 && completed == 3 && ack == 0x01,
           "golden-block-read-ok");
    expect(t.lastRequest == std::vector<uint8_t>({0x06, 0x00, 0x03, 0x00, 0x0F}),
           "golden-block-read-request");
    expect(values[0] == 0xA5A5A5A5u && values[2] == 0xA5A5A5A5u, "golden-block-read-data");
  }

  {
    // Golden: block read WAIT partial (count16=1 of 3, status WAIT) fails
    // with DapAckWait and reports completed=1.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0x12345678u);
    t.scripted = {0x06, 0x01, 0x00, 0x02};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r =
        protocol.dapTransferBlockRead(0, 0x0F, 3, values, ack, completed,
                                      std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kDapAckWait && completed == 1,
           "golden-block-read-wait-partial");
  }

  {
    // Golden: block read count exceeding the requested count is rejected.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(1u);
    t.scripted = {0x06, 0x02, 0x00, 0x01};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r =
        protocol.dapTransferBlockRead(0, 0x0F, 1, values, ack, completed,
                                      std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-read-count-over");
  }

  {
    // Golden: block read with truncated data (declares 2, carries 1 word) is
    // rejected as malformed.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(1u);
    t.scripted = {0x06, 0x02, 0x00, 0x01};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r =
        protocol.dapTransferBlockRead(0, 0x0F, 3, values, ack, completed,
                                      std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-read-truncated");
  }

  {
    // Golden: block write request is [0x06][dap=0][count16 LE=2][0x0D]
    // [value0 LE][value1 LE]; the response is [0x06][count16=2][status OK]
    // with no data.
    ScriptedTransport t;
    t.scripted = {0x06, 0x02, 0x00, 0x01};
    CmsisDapProtocol protocol(&t);
    uint8_t ack = 0;
    uint16_t completed = 0;
    const std::vector<uint32_t> values = {0xDEADBEEFu, 0x12345678u};
    const Result r = protocol.dapTransferBlockWrite(0, 0x0D, values, ack, completed,
                                                    std::chrono::milliseconds(200));
    expect(r.ok && ack == 0x01 && completed == 2, "golden-block-write-ok");
    expect(t.lastRequest ==
               std::vector<uint8_t>({0x06, 0x00, 0x02, 0x00, 0x0D, 0xEF, 0xBE, 0xAD, 0xDE,
                                     0x78, 0x56, 0x34, 0x12}),
           "golden-block-write-request");
  }

  {
    // Golden: block write whose response count16 (1) differs from the
    // requested (2) is malformed with an unknown completion state: the write
    // command is sent exactly once and never retried.
    ScriptedTransport t;
    t.scripted = {0x06, 0x01, 0x00, 0x01};
    CmsisDapProtocol protocol(&t);
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockWrite(0, 0x0D, {0x01u, 0x02u}, ack, completed,
                                                    std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-write-unknown-not-retried");
    expect(t.writeCalls == 1, "golden-block-write-sent-once");
  }

  // --- Strict Transfer Response status validation: reserved/undefined
  // status bits (0x11, 0x21, 0x41, 0x81) must be rejected before the ACK is
  // read, so a corrupt status can never silently degrade into ACK_OK. All
  // frames below are hardcoded against the official layout. ---

  {
    // Golden: block read status=0x11 (bit4 is undefined for
    // DAP_TransferBlock) with a complete count is malformed and yields NO
    // data to the caller.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0x11111111u);
    t.scripted = {0x06, 0x02, 0x00, 0x11};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockRead(0, 0x0F, 2, values, ack, completed,
                                                   std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-read-status-0x11");
    expect(values.empty(), "golden-block-read-status-0x11-no-data");
  }

  {
    // Golden: block read status=0x21 (bit5) is rejected.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0x22222222u);
    t.scripted = {0x06, 0x02, 0x00, 0x21};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockRead(0, 0x0F, 2, values, ack, completed,
                                                   std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-read-status-0x21");
    expect(values.empty(), "golden-block-read-status-0x21-no-data");
  }

  {
    // Golden: block read status=0x41 (bit6) is rejected.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0x44444444u);
    t.scripted = {0x06, 0x02, 0x00, 0x41};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockRead(0, 0x0F, 2, values, ack, completed,
                                                   std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-read-status-0x41");
    expect(values.empty(), "golden-block-read-status-0x41-no-data");
  }

  {
    // Golden: block read status=0x81 (bit7) is rejected.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0x88888888u);
    t.scripted = {0x06, 0x02, 0x00, 0x81};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockRead(0, 0x0F, 2, values, ack, completed,
                                                   std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-read-status-0x81");
    expect(values.empty(), "golden-block-read-status-0x81-no-data");
  }

  {
    // Golden: block read status=0x09 (Protocol Error) keeps its explicit
    // ProtocolError semantics and yields no data.
    ScriptedTransport t;
    const std::vector<uint8_t> word = goldenLe32(0x99999999u);
    t.scripted = {0x06, 0x02, 0x00, 0x09};
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    t.scripted.insert(t.scripted.end(), word.begin(), word.end());
    CmsisDapProtocol protocol(&t);
    std::vector<uint32_t> values;
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockRead(0, 0x0F, 2, values, ack, completed,
                                                   std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kProtocolError,
           "golden-block-read-status-0x09");
    expect(values.empty(), "golden-block-read-status-0x09-no-data");
  }

  {
    // Golden: block write status=0x11 with a matching count: the undefined
    // bit4 makes the completion state unknown; malformed and never retried.
    ScriptedTransport t;
    t.scripted = {0x06, 0x02, 0x00, 0x11};
    CmsisDapProtocol protocol(&t);
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockWrite(0, 0x0D, {0x01u, 0x02u}, ack, completed,
                                                    std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-write-status-0x11");
    expect(t.writeCalls == 1, "golden-block-write-status-0x11-sent-once");
  }

  {
    // Golden: block write status=0x21 (bit5) is malformed and never retried.
    ScriptedTransport t;
    t.scripted = {0x06, 0x02, 0x00, 0x21};
    CmsisDapProtocol protocol(&t);
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockWrite(0, 0x0D, {0x01u, 0x02u}, ack, completed,
                                                    std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-write-status-0x21");
    expect(t.writeCalls == 1, "golden-block-write-status-0x21-sent-once");
  }

  {
    // Golden: block write status=0x81 (bit7) is malformed and never retried.
    ScriptedTransport t;
    t.scripted = {0x06, 0x02, 0x00, 0x81};
    CmsisDapProtocol protocol(&t);
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockWrite(0, 0x0D, {0x01u, 0x02u}, ack, completed,
                                                    std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-block-write-status-0x81");
    expect(t.writeCalls == 1, "golden-block-write-status-0x81-sent-once");
  }

  {
    // Golden: block write status=0x09 (Protocol Error) is an explicit
    // ProtocolError with an unknown completion state; never retried.
    ScriptedTransport t;
    t.scripted = {0x06, 0x02, 0x00, 0x09};
    CmsisDapProtocol protocol(&t);
    uint8_t ack = 0;
    uint16_t completed = 0;
    const Result r = protocol.dapTransferBlockWrite(0, 0x0D, {0x01u, 0x02u}, ack, completed,
                                                    std::chrono::milliseconds(200));
    expect(!r.ok && r.errorCode == ErrorCodes::kProtocolError,
           "golden-block-write-status-0x09");
    expect(t.writeCalls == 1, "golden-block-write-status-0x09-sent-once");
  }

  {
    // Golden: DAP_Transfer status=0x21 (reserved bit5) is rejected and the
    // read item is NOT filled with unconfirmed data.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x21, 0xEF, 0xBE, 0xAD, 0xDE},
                                         false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-transfer-status-0x21");
    expect(!items[0].readDataValid, "golden-transfer-status-0x21-no-data");
  }

  {
    // Golden: DAP_Transfer status=0x41 (reserved bit6) is rejected.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x41, 0xEF, 0xBE, 0xAD, 0xDE},
                                         false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-transfer-status-0x41");
  }

  {
    // Golden: DAP_Transfer status=0x81 (reserved bit7) is rejected.
    ScriptedTransport t;
    std::vector<DapTransferItem> items;
    const Result r = runScriptedTransfer({0x05, 0x01, 0x81, 0xEF, 0xBE, 0xAD, 0xDE},
                                         false, true, 0, items, t);
    expect(!r.ok && r.errorCode == ErrorCodes::kMalformedResponse,
           "golden-transfer-status-0x81");
  }

  // --- Mock oracle: the independently written mock (its own constants and
  // frame layout) must agree with the production encoding byte-for-byte on
  // the wire, and must refuse unsupported Match/Mask/Timestamp request bits.
  {
    // Isolate the Cortex-M return path from Flash controller behavior. The
    // mock interprets only BX LR followed by a RAM BKPT sentinel; it does not
    // mutate Flash or model any STM32 peripheral.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap02a-ram-stub-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    expect(debug.halt(state, diag, std::chrono::milliseconds(100)).ok && state.halted,
           "dap02a-ram-stub-halted-precondition");
    const uint32_t stubAddress = 0x20000000u;
    const uint32_t bkptAddress = stubAddress + 4u;
    std::vector<uint8_t> stub({0x47, 0x70, 0xBF, 0xBF, 0x00, 0xBE});
    std::vector<uint8_t> noData;
    FlashAlgorithmRunRequest stubRequest;
    stubRequest.operation = "ramStub";
    stubRequest.code = &stub;
    stubRequest.data = &noData;
    stubRequest.algorithmAddress = stubAddress;
    stubRequest.entry = stubAddress;
    stubRequest.bkptAddress = bkptAddress;
    stubRequest.stackPointer = 0x2001F000u;
    stubRequest.stackSize = 0x1000u;
    stubRequest.pageBufferAddress = 0x20000100u;
    stubRequest.targetAddress = 0x08000000u;
    stubRequest.size = 0;
    stubRequest.r0 = 0x12345678u;
    stubRequest.staticBase = stubAddress;
    mock.prepareRamStub(stubRequest.entry, stubRequest.bkptAddress);
    FlashAlgorithmRunResult stubResult;
    const Result stubRun = debug.executeFlashAlgorithm(
        stubRequest, stubResult, diag, std::chrono::milliseconds(100));
    expect(stubRun.ok && stubResult.pc == bkptAddress &&
               (stubResult.dhcsr & kCoreDebugSHalt) != 0 &&
               mock.injection().algorithmLrAtEntry == (bkptAddress | 1u) &&
               mock.injection().algorithmPcAtEntry == (stubRequest.entry | 1u) &&
               mock.targetState().registers[14] == (bkptAddress | 1u) &&
               mock.targetState().registers[13] == stubRequest.stackPointer &&
               mock.targetState().registers[0] == stubRequest.r0 &&
               mock.injection().algorithmXpsrAtEntry == kCortexXpsrThumb,
           "dap02a-ram-stub-bx-lr-bkpt-state");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-raw-open-normal");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    uint32_t idcode = 0;
    expect(target.readDp(kDpRegAbortIdcode, idcode, diag).ok, "dap03-raw-idcode-read");
    expect(mock.lastTransferRequest() == std::vector<uint8_t>({0x05, 0x00, 0x01, 0x02}),
           "dap03-raw-idcode-frame");
    std::vector<uint32_t> words;
    diag = DapTransferDiagnostics{};
    expect(target.readMemoryBlock(0x20000000, 2, words, diag).ok && words.size() == 2,
           "dap03-raw-block-read");
    expect(mock.lastBlockRequest() ==
               std::vector<uint8_t>({0x06, 0x00, 0x01, 0x00, 0x0F}),
           "dap03-raw-block-frame");
  }

  {
    // Mock oracle: a raw DAP_Transfer request carrying the Value Match bit is
    // refused with FAULT, never silently reinterpreted.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-raw-open-unsupported");
    const uint8_t request[] = {0x05, 0x00, 0x01, 0x02 | 0x10};  // DP read + Value Match
    expect(mock.writePacket(request, sizeof(request), std::chrono::milliseconds(100)).ok,
           "dap03-raw-unsupported-written");
    uint8_t buffer[64] = {};
    size_t length = 0;
    expect(mock.readPacket(buffer, sizeof(buffer), length,
                           std::chrono::milliseconds(100)).ok &&
               length == 3 && buffer[0] == 0x05 && buffer[1] == 0x00 && buffer[2] == 0x04,
           "dap03-raw-unsupported-refused-fault");
  }

  {
    // OpenOCD's SWD DP initialization uses ordinary DAP_Transfer writes. It
    // first clears sticky state with DP ABORT, writes power requests together
    // with SSTICKYERR|SSTICKYORUN, reads CTRL/STAT, writes the clean request,
    // then polls both power ACK bits. This raw sequence must remain usable on
    // DAPLink firmware whose dedicated DAP_WriteABORT response does not carry
    // the underlying SWD ACK.
    ScriptedTransport t;
    t.scriptedResponses = {
        {0x05, 0x01, 0x01},
        {0x05, 0x01, 0x01},
        {0x05, 0x01, 0x01, 0x00, 0x00, 0x00, 0xF0},
        {0x05, 0x01, 0x01},
        {0x05, 0x01, 0x01, 0x00, 0x00, 0x00, 0xF0},
    };
    CmsisDapProtocol protocol(&t);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    const Result result = target.initializeDebugPower(diag, std::chrono::milliseconds(100));
    expect(result.ok, "dap03-openocd-dp-init-succeeds");
    expect(t.requests == std::vector<std::vector<uint8_t>>({
               {0x05, 0x00, 0x01, 0x00, 0x1E, 0x00, 0x00, 0x00},
               {0x05, 0x00, 0x01, 0x04, 0x22, 0x00, 0x00, 0x50},
               {0x05, 0x00, 0x01, 0x06},
               {0x05, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x50},
               {0x05, 0x00, 0x01, 0x06},
           }),
           "dap03-openocd-dp-init-request-order");
  }

  {
    // Golden: DAP_WriteABORT is the dedicated CMSIS-DAP DP ABORT command.
    // Its request is [0x08][DAP index][ABORT value LE32] and its response is
    // [0x08][DAP_OK]. A probe may support DP reads through DAP_Transfer while
    // requiring this command for ABORT writes.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-write-abort-open");
    const uint8_t request[] = {0x08, 0x00, 0x1E, 0x00, 0x00, 0x00};
    expect(mock.writePacket(request, sizeof(request), std::chrono::milliseconds(100)).ok,
           "dap03-write-abort-written");
    uint8_t buffer[64] = {};
    size_t length = 0;
    expect(mock.readPacket(buffer, sizeof(buffer), length,
                           std::chrono::milliseconds(100)).ok &&
               length == 2 && buffer[0] == 0x08 && buffer[1] == 0x00,
           "dap03-write-abort-response");
  }

  {
    // Golden: the production protocol encoder uses the official dedicated
    // DAP_WriteABORT frame and validates its DAP_OK response.
    ScriptedTransport t;
    t.scripted = {0x08, 0x00};
    CmsisDapProtocol protocol(&t);
    const Result result = protocol.writeAbort(0, 0xA05F001Eu,
                                              std::chrono::milliseconds(100));
    expect(result.ok, "dap03-write-abort-protocol-ok");
    expect(t.lastRequest == std::vector<uint8_t>({0x08, 0x00, 0x1E, 0x00, 0x5F, 0xA0}),
           "dap03-write-abort-protocol-frame");
  }

  // --- MEM-AP CSW encoding: strict Size/AddrInc shape checks. The ADIv5 CSW
  // layout is Size=bits[2:0] (32-bit = 0b010; DeviceEn is bit6, outside the
  // Size field) and AddrInc=bits[5:4] (single = 0b01). 0x95 and 0x02000095
  // both carry the reserved Size encoding 0b101 in bits[2:0], which the
  // verified STM32F407 AHB-AP reads back as 0b001 (16-bit accesses with stale
  // upper halves); both must be rejected. 0x13 carries Size=0b011, which the
  // verified target does not support, and must also be rejected.
  {
    expect(MockCmsisDapTransport::cswShapeOk(kApCsw32Auto),
           "dap03-csw-32bit-single-accepted");
    expect(MockCmsisDapTransport::cswShapeOk(0x12u),
           "dap03-csw-explicit-0x12-accepted");
    expect(!MockCmsisDapTransport::cswShapeOk(0x95u),
           "dap03-csw-0x95-rejected");
    expect(!MockCmsisDapTransport::cswShapeOk(0x02000095u),
           "dap03-csw-0x02000095-rejected");
    expect(!MockCmsisDapTransport::cswShapeOk(0x10u),
           "dap03-csw-size-8-rejected");      // Size bits[2:0] = 0b000
    expect(!MockCmsisDapTransport::cswShapeOk(0x11u),
           "dap03-csw-size-16-rejected");     // Size bits[2:0] = 0b001
    expect(!MockCmsisDapTransport::cswShapeOk(0x13u),
           "dap03-csw-size-64-rejected");     // Size bits[2:0] = 0b011
    expect(!MockCmsisDapTransport::cswShapeOk(0x14u),
           "dap03-csw-size-128-rejected");    // Size bits[2:0] = 0b100
    expect(!MockCmsisDapTransport::cswShapeOk(0x15u),
           "dap03-csw-size-reserved-5-rejected");  // Size bits[2:0] = 0b101
    expect(!MockCmsisDapTransport::cswShapeOk(0x16u),
           "dap03-csw-size-reserved-6-rejected");  // Size bits[2:0] = 0b110
    expect(!MockCmsisDapTransport::cswShapeOk(0x17u),
           "dap03-csw-size-reserved-7-rejected");  // Size bits[2:0] = 0b111
    expect(!MockCmsisDapTransport::cswShapeOk(0x02u),
           "dap03-csw-addrincoff-rejected");   // AddrInc bits[5:4] = 0b00
    expect(!MockCmsisDapTransport::cswShapeOk(0x22u),
           "dap03-csw-addrinc-packed-rejected");  // AddrInc bits[5:4] = 0b10
  }

  // --- DAP-04 Cortex-M CoreDebug mock state machine. These cases deliberately
  // use the CMSIS-DAP DP/AP owner and never a J-Link or direct memory oracle.
  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap04-open-swd-init-sequence");
    CmsisDapProtocol protocol(&mock);
    uint8_t connectedPort = 0;
    const Result connectResult =
        protocol.connect(kPortSwd, connectedPort, std::chrono::milliseconds(100),
                         1000000, false);
    expect(connectResult.ok && connectedPort == kPortSwd,
           "dap04-swd-init-sequence-connect");
    expect(mock.commandHistory() == std::vector<uint8_t>({
               kMockCmdConnect,
               kMockCmdSwjClock,
               kMockCmdSwjSequence,
               kMockCmdSwjClock,
               kMockCmdTransferConfigure,
               kMockCmdSwdConfigure,
               kMockCmdTransfer}),
           "dap04-swd-init-sequence-command-order");
    expect(mock.lastTransferRequest() ==
               std::vector<uint8_t>({0x05, 0x00, 0x01, 0x02}),
           "dap04-swd-prime-dpidr-frame");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap04-open-coredebug");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const auto timeout = std::chrono::milliseconds(100);

    expect(debug.getState(state, diag, timeout).ok && !state.halted &&
               state.dhcsr == kCoreDebugCDebugEn,
           "dap04-getstate-running");
    // STM32F407's AHB-AP requires the OpenOCD AHB debug defaults in CSW for
    // CoreDebug accesses: HPROT1, MASTER_DEBUG, and DBGSWENABLE, plus 32-bit
    // single-increment transfer fields.
    expect(mock.targetState().apCsw == 0xA2000012u,
           "dap04-coredebug-csw-ahb-debug-default");
    expect(debug.halt(state, diag, timeout).ok && state.halted,
           "dap04-halt-confirmed");
    expect(mock.injection().blockWriteCount == 0,
           "dap04-coredebug-control-uses-single-transfer");
    expect(mock.targetState().lastDhcsrWrite ==
               (kCoreDebugDbgKey | kCoreDebugCDebugEn | kCoreDebugCHalt),
           "dap04-halt-key-and-bits");
    expect(debug.run(state, diag, timeout).ok && !state.halted,
           "dap04-run-confirmed");
    expect(mock.targetState().lastDhcsrWrite ==
               (kCoreDebugDbgKey | kCoreDebugCDebugEn),
           "dap04-run-key-and-bits");
    expect(debug.halt(state, diag, timeout).ok && state.halted,
           "dap04-step-precondition-halt");

    CortexMDebugStepResult step;
    const Result stepResult = debug.stepInstruction(step, diag, timeout);
    expect(stepResult.ok && step.halted && step.pcAfter != step.pcBefore,
           "dap04-step-pc-changed-and-halted");
    expect(mock.targetState().lastDhcsrWrite ==
               (kCoreDebugDbgKey | kCoreDebugCDebugEn | kCoreDebugCStep),
           "dap04-step-key-and-bits");

    uint32_t value = 0;
    expect(debug.readRegister(0, value, diag, timeout).ok && value == 0x10000000u,
           "dap04-read-r0");
    expect(debug.readRegister(13, value, diag, timeout).ok && value == 0x20001000u,
           "dap04-read-sp");
    expect(debug.readRegister(14, value, diag, timeout).ok && value == 0x08001001u,
           "dap04-read-lr");
    expect(debug.readRegister(15, value, diag, timeout).ok && value == step.pcAfter,
           "dap04-read-pc");
    expect(debug.readRegister(16, value, diag, timeout).ok && value == 0x01000000u,
           "dap04-read-xpsr");
    const Result invalidRegister = debug.readRegister(17, value, diag, timeout);
    expect(!invalidRegister.ok && invalidRegister.errorCode == ErrorCodes::kDapInvalidRequest,
           "dap04-invalid-register");

    expect(debug.reset(state, diag, timeout).ok && state.halted && state.pc == kMockResetPc,
           "dap04-reset-confirmed");
    expect(mock.targetState().lastAircrWrite ==
               (kCoreDebugVectKey | kCoreDebugSysResetReq),
           "dap04-reset-key-and-bit");
  }

  {
    // TAR single auto-increment stays 4 bytes and wraps at the 1 KiB boundary:
    // a 2-word block starting at 0x20000FFC must return the words at
    // 0x20000FFC and 0x20001000, each matching the mock oracle pattern.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-open-boundary-block");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> words;
    const Result result = target.readMemoryBlock(0x20000FFC, 2, words, diag);
    expect(result.ok && words.size() == 2, "dap03-boundary-block-ok");
    expect(diag.chunks == 2, "dap03-boundary-block-two-chunks");
    if (result.ok && words.size() == 2) {
      expect(words[0] == mockWordAt(0x20000FFC), "dap03-boundary-word0");
      expect(words[1] == mockWordAt(0x20001000), "dap03-boundary-word1-4byte-increment");
    }
  }

  // --- DAP-04 control error propagation. These cases use the same CoreDebug
  // state machine as the happy path, but inject transport/DP outcomes at the
  // MEM-AP owner boundary. No retry is allowed outside the bounded target
  // layer, and every failure retains its machine-readable code. ---
  {
    // The restricted Flash Algorithm primitive must write the CMSIS-Pack
    // registers and RAM regions internally, then accept only the trusted BKPT
    // completion. This is a native helper self-test, not a general register
    // or write-memory RPC test.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap02a-algorithm-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    expect(debug.halt(state, diag, std::chrono::milliseconds(100)).ok && state.halted,
           "dap02a-algorithm-halted-precondition");

    std::vector<uint8_t> code(0x600, 0xBF);
    code[0x500] = 0x00;
    code[0x501] = 0xBE;
    std::vector<uint8_t> data({0x00, 0x01, 0x02, 0x03});
    FlashAlgorithmRunRequest request;
    request.operation = "programPage";
    request.code = &code;
    request.data = &data;
    request.algorithmAddress = 0x20000000u;
    request.entry = 0x20000300u;
    request.bkptAddress = 0x20000500u;
    request.stackPointer = 0x2001F000u;
    request.stackSize = 0x1000u;
    request.pageBufferAddress = 0x20000600u;
    request.targetAddress = 0x08000000u;
    request.size = 4;
    request.r0 = request.targetAddress;
    request.r1 = request.size;
    request.r2 = request.pageBufferAddress;
    request.r3 = 0;
    request.staticBase = request.algorithmAddress;
    request.timeoutMs = 100;
    FlashAlgorithmRunRequest eraseRequest = request;
    eraseRequest.operation = "eraseSector";
    eraseRequest.size = 0x4000u;
    eraseRequest.r1 = 0;
    eraseRequest.r2 = 0;
    eraseRequest.r3 = 0;
    mock.prepareFlashAlgorithm("eraseSector", eraseRequest.targetAddress,
                               eraseRequest.size, {}, eraseRequest.bkptAddress);
    FlashAlgorithmRunResult eraseResult;
    const Result erase = debug.executeFlashAlgorithm(
        eraseRequest, eraseResult, diag, std::chrono::milliseconds(100));
    expect(erase.ok && eraseResult.returnCode == 0, "dap02a-algorithm-preerase");
    mock.prepareFlashAlgorithm("programPage", request.targetAddress, request.size, data,
                               request.bkptAddress);
    FlashAlgorithmRunResult algorithmResult;
    CortexMDebugDiagnostics successDiagnostics;
    const Result algorithm = debug.executeFlashAlgorithm(
        request, algorithmResult, diag, std::chrono::milliseconds(100),
        &successDiagnostics);
    expect(algorithm.ok && algorithmResult.returnCode == 0,
           "dap02a-algorithm-return-code");
    expect(algorithmResult.pc == request.bkptAddress &&
               (algorithmResult.dhcsr & kCoreDebugSHalt) != 0,
           "dap02a-algorithm-bkpt-halt");
    expect(mock.injection().algorithmR0AtEntry == request.r0 &&
               mock.injection().algorithmR1AtEntry == request.r1 &&
               mock.injection().algorithmR2AtEntry == request.r2 &&
               mock.injection().algorithmR3AtEntry == request.r3 &&
               mock.injection().algorithmR9AtEntry == request.staticBase &&
               mock.injection().algorithmSpAtEntry == request.stackPointer &&
               mock.injection().algorithmLrAtEntry == (request.bkptAddress | 1u) &&
               mock.injection().algorithmPcAtEntry == (request.entry | 1u) &&
               mock.injection().algorithmXpsrAtEntry == kCortexXpsrThumb &&
               mock.targetState().registers[0] == algorithmResult.returnCode,
           "dap02a-algorithm-register-parameters");
    expect(successDiagnostics.before.registersValid &&
               !successDiagnostics.after.dhcsrValid &&
               !successDiagnostics.after.registersValid,
           "dap02a-algorithm-success-skips-redundant-after-snapshot");
    expect(mock.targetState().ram[0x000] == code[0x000] &&
               mock.targetState().ram[0x500] == 0x00 &&
               mock.targetState().ram[0x501] == 0xBE &&
               mock.targetState().ram[0x600] == data[0],
           "dap02a-algorithm-ram-layout-written");
    const uint32_t blockWritesAfterFirstCall = mock.injection().blockWriteCount;
    FlashAlgorithmRunRequest cachedRequest = request;
    cachedRequest.loadAlgorithmCode = false;
    mock.prepareFlashAlgorithm("programPage", cachedRequest.targetAddress,
                               cachedRequest.size, data, cachedRequest.bkptAddress);
    FlashAlgorithmRunResult cachedResult;
    const Result cachedRun = debug.executeFlashAlgorithm(
        cachedRequest, cachedResult, diag, std::chrono::milliseconds(100));
    expect(cachedRun.ok && cachedResult.returnCode == 0 &&
               mock.injection().blockWriteCount == blockWritesAfterFirstCall + 1,
           "dap02a-algorithm-cached-code-only-page-buffer-write");
    const uint32_t blockWritesAfterCachedCall = mock.injection().blockWriteCount;
    FlashAlgorithmRunRequest reusedBufferRequest = cachedRequest;
    reusedBufferRequest.operation = "verify";
    reusedBufferRequest.entry = 0x20000400u;
    reusedBufferRequest.loadPageData = false;
    mock.prepareFlashAlgorithm("verify", reusedBufferRequest.targetAddress,
                               reusedBufferRequest.size, data,
                               reusedBufferRequest.bkptAddress);
    FlashAlgorithmRunResult reusedBufferResult;
    const Result reusedBufferRun = debug.executeFlashAlgorithm(
        reusedBufferRequest, reusedBufferResult, diag, std::chrono::milliseconds(100));
    expect(reusedBufferRun.ok && reusedBufferResult.returnCode == 0 &&
               mock.injection().blockWriteCount == blockWritesAfterCachedCall,
           "dap02a-algorithm-validated-page-buffer-reuse-skips-write");
    FlashAlgorithmRunResult invalidResult;
    FlashAlgorithmRunRequest oddEntry = request;
    oddEntry.entry |= 1u;
    expect(!debug.executeFlashAlgorithm(oddEntry, invalidResult, diag,
                                        std::chrono::milliseconds(100)).ok,
           "dap02a-algorithm-pc-thumb-bit-rejected-as-entry-offset");
    FlashAlgorithmRunRequest overlappingBuffer = request;
    overlappingBuffer.pageBufferAddress = request.algorithmAddress + 0x10u;
    expect(!debug.executeFlashAlgorithm(overlappingBuffer, invalidResult, diag,
                                        std::chrono::milliseconds(100)).ok,
           "dap02a-algorithm-code-buffer-overlap-rejected");
    FlashAlgorithmRunRequest unalignedStack = request;
    unalignedStack.stackPointer -= 4u;
    expect(!debug.executeFlashAlgorithm(unalignedStack, invalidResult, diag,
                                        std::chrono::milliseconds(100)).ok,
           "dap02a-algorithm-stack-eight-byte-alignment-rejected");
    FlashAlgorithmRunRequest missingBkpt = request;
    missingBkpt.bkptAddress = request.algorithmAddress + 0x20u;
    expect(!debug.executeFlashAlgorithm(missingBkpt, invalidResult, diag,
                                        std::chrono::milliseconds(100)).ok,
           "dap02a-algorithm-bkpt-image-membership-rejected");
  }

  {
    // The algorithm remains running after launch. This must return one
    // diagnostic timeout with the last core/fault snapshot and must not
    // silently invoke the algorithm a second time.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "568B", mock), "dap02a-algorithm-timeout-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    expect(debug.halt(state, diag, std::chrono::milliseconds(100)).ok && state.halted,
           "dap02a-algorithm-timeout-halted-precondition");
    std::vector<uint8_t> code(0x600, 0xBF);
    code[0x500] = 0x00;
    code[0x501] = 0xBE;
    std::vector<uint8_t> noData;
    FlashAlgorithmRunRequest request;
    request.operation = "init";
    request.code = &code;
    request.data = &noData;
    request.algorithmAddress = 0x20000000u;
    request.entry = 0x20000000u;
    request.bkptAddress = 0x20000500u;
    request.stackPointer = 0x2001F000u;
    request.stackSize = 0x1000u;
    request.pageBufferAddress = 0x20000600u;
    request.targetAddress = 0x08000000u;
    request.r0 = 0x08000000u;
    request.r1 = 4000000u;
    mock.prepareFlashAlgorithm("init", request.targetAddress, 0, noData, request.bkptAddress);
    CortexMDebugDiagnostics operationDiagnostics;
    FlashAlgorithmRunResult algorithmResult;
    const Result algorithm = debug.executeFlashAlgorithm(
        request, algorithmResult, diag, std::chrono::milliseconds(20), &operationDiagnostics);
    expect(!algorithm.ok && algorithm.errorCode == ErrorCodes::kDapControlTimeout &&
               algorithm.message.find("operation=init") != std::string::npos &&
               algorithm.message.find("pc=0x20000001") != std::string::npos &&
               algorithm.message.find("lr=0x20000501") != std::string::npos &&
               algorithm.message.find("registerSource=before") != std::string::npos &&
               operationDiagnostics.before.registersValid &&
               operationDiagnostics.before.pc == (request.entry | 1u) &&
               operationDiagnostics.before.lr == (request.bkptAddress | 1u) &&
               operationDiagnostics.after.dhcsrValid &&
               operationDiagnostics.after.faultStatusValid &&
               !operationDiagnostics.after.registersValid &&
               mock.injection().flashAlgorithmCount == 1 &&
               (operationDiagnostics.after.dhcsr & kCoreDebugSHalt) == 0,
           "dap02a-algorithm-timeout-diagnostics-no-retry");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5683", mock), "dap04-open-control-wait");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result result = debug.halt(state, diag, std::chrono::milliseconds(25));
    expect(!result.ok && result.errorCode == ErrorCodes::kDapAckWait,
           "dap04-control-wait-propagated");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5680", mock), "dap04-open-control-fault");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result result = debug.halt(state, diag, std::chrono::milliseconds(100));
    expect(result.ok && diag.faultClears >= 1, "dap04-control-fault-cleared");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5681", mock), "dap04-open-control-no-ack");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result result = debug.getState(state, diag, std::chrono::milliseconds(100));
    expect(!result.ok && result.errorCode == ErrorCodes::kDapAckNoAck,
           "dap04-control-no-ack-propagated");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5685", mock), "dap04-open-control-removal");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result removed = debug.getState(state, diag, std::chrono::milliseconds(100));
    expect(!removed.ok && removed.errorCode == ErrorCodes::kDeviceRemoved,
           "dap04-control-device-removed");
    const Result stillRemoved = debug.getState(state, diag, std::chrono::milliseconds(100));
    expect(!stillRemoved.ok && stillRemoved.errorCode == ErrorCodes::kDeviceRemoved,
           "dap04-control-device-removed-sticky");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5686", mock), "dap04-open-control-timeout");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result result = debug.halt(state, diag, std::chrono::milliseconds(10));
    expect(!result.ok && result.errorCode == ErrorCodes::kDapControlTimeout,
           "dap04-control-timeout");
  }

  {
    // Disconnect is an owner boundary: post-close CoreDebug access must not
    // be reported as a stale state or silently reconnected.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap04-open-disconnect-invalid-state");
    expect(mock.close().ok, "dap04-close-disconnect-invalid-state");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result result = debug.getState(state, diag, std::chrono::milliseconds(100));
    expect(!result.ok && result.errorCode == ErrorCodes::kInvalidState,
           "dap04-disconnect-invalid-state");
  }

  {
    // Block reads: every returned word corresponds to 4 consecutive bytes of
    // the same region, i.e. the byte-oriented readMemory and the word-oriented
    // readMemoryBlock agree byte-for-byte over the same 16-byte range.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap03-open-word-byte-consistency");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint8_t> bytes;
    const Result byteRead = target.readMemory(0x20000000, 16, bytes, diag);
    expect(byteRead.ok && bytes.size() == 16, "dap03-word-byte-byte-read");
    std::vector<uint32_t> words;
    diag = DapTransferDiagnostics{};
    const Result blockRead = target.readMemoryBlock(0x20000000, 4, words, diag);
    expect(blockRead.ok && words.size() == 4, "dap03-word-byte-block-read");
    if (byteRead.ok && blockRead.ok && words.size() == 4 && bytes.size() == 16) {
      bool consistent = true;
      for (size_t w = 0; w < 4; ++w) {
        for (size_t b = 0; b < 4; ++b) {
          const uint8_t expected =
              static_cast<uint8_t>((words[w] >> (8 * b)) & 0xFF);
          if (bytes[w * 4 + b] != expected) consistent = false;
        }
      }
      expect(consistent, "dap03-word-byte-each-word-4-bytes");
    }
  }

  std::cout << "{\"selftest\":\"" << (failures == 0 ? "ok" : "fail")
            << "\",\"cases\":" << 163 << ",\"failures\":" << failures << "}\n"
            << std::flush;
  return failures == 0 ? 0 : 1;
}

}  // namespace

int run(int argc, char** argv) {
  Channel channel;
  bool selfTestRequested = false;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg.rfind("--transport=", 0) == 0) {
      channel.requestedTransport = arg.substr(std::string("--transport=").size());
    } else if (arg == "--selftest") {
      selfTestRequested = true;
    }
  }
  if (selfTestRequested) return runSelfTest();
  if (channel.requestedTransport.empty()) channel.requestedTransport = "hid";
  diag("starting helper version=" + std::string(kHelperVersion) + " protocol=" +
       std::to_string(kProtocolVersion) + " defaultTransport=" + channel.requestedTransport);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::string response;
    try {
      const JsonValue request = JsonParser(line).parse();
      response = dispatch(request, channel);
    } catch (const std::exception& error) {
      response = protocolError(line, error.what());
    }
    std::cout << response << '\n' << std::flush;
  }
  diag("stdin closed, exiting");
  return 0;
}

}  // namespace cmsis_dap_helper

int main(int argc, char** argv) {
  return cmsis_dap_helper::run(argc, argv);
}
