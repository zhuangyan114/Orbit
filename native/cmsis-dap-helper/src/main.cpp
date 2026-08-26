#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <iostream>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <windows.h>

#include "cmsis_dap_hid_transport.h"
#include "cmsis_dap_winusb_transport.h"
#include "cmsis_dap_protocol.h"
#include "cmsis_dap_target.h"
#include "cmsis_dap_transport.h"
#include "cmsis_dap_source_step.h"
#include "cmsis_dap_startup_stop.h"
#include "cortex_m_debug.h"
#include "fpb_breakpoint.h"
#include "json_rpc.h"
#include "mock_transport.h"
#include "segger_rtt.h"
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
constexpr uint32_t kMaxMemoryWriteBytes = 65536;
constexpr uint32_t kMaxMemoryBlockWords = 16384;
constexpr size_t kMaxMemoryBatchReads = 1024;
constexpr uint64_t kMaxMemoryBatchBytes = 65536;
constexpr size_t kMaxMemoryBatchRequestBytes = 131072;

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
  if (!value || value->kind != JsonValue::Kind::Number || !std::isfinite(value->number) ||
      value->number < 0 || value->number > static_cast<double>(UINT64_MAX) ||
      value->number != std::floor(value->number)) return std::nullopt;
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
  bool debugPowerReady = false;
  uint16_t packetSize = 0;  // effective packet size from the last DAP_Info
  bool flashAlgorithmLoaded = false;
  uint32_t flashAlgorithmAddress = 0;
  std::vector<uint8_t> flashAlgorithmCode;
  bool flashPageBufferValid = false;
  uint32_t flashPageBufferAddress = 0;
  uint32_t flashPageTargetAddress = 0;
  uint32_t flashPageSize = 0;
  std::vector<uint8_t> flashPageData;
  FpbState fpbState;
  SeggerRttReader rttReader;

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

  void clearDebugResourceState() {
    debugPowerReady = false;
    fpbState.reset();
    rttReader.stop();
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

Result ensureDebugPower(Channel& channel, CmsisDapTarget& target,
                        DapTransferDiagnostics& diagnostics,
                        std::chrono::milliseconds timeout) {
  if (channel.debugPowerReady) return Result::success();
  const Result result = target.initializeDebugPower(diagnostics, timeout);
  channel.debugPowerReady = result.ok;
  return result;
}

// Creates one physical transport owner. "auto" is resolved by the handlers
// after enumeration so WinUSB is preferred without creating two open owners.
std::unique_ptr<CmsisDapTransport> createTransport(const std::string& name, std::string& error) {
  if (name == "hid") return std::make_unique<CmsisDapHidTransport>();
  if (name == "winusb" || name == "cmsis-dap-v2") return std::make_unique<CmsisDapWinUsbTransport>();
  if (name == "mock") return std::make_unique<MockCmsisDapTransport>();
  error = "transport '" + name + "' is not implemented yet";
  return nullptr;
}

Result enumeratePreferred(const std::string& requested, const DeviceSelector& selector,
                          std::unique_ptr<CmsisDapTransport>& selected,
                          std::vector<DeviceDescriptor>& devices, std::string& chosen) {
  const std::vector<std::string> candidates =
      requested == "auto" ? std::vector<std::string>{"winusb", "hid"}
                           : std::vector<std::string>{requested == "cmsis-dap-v2" ? "winusb" :
                                                       requested == "cmsis-dap" ? "hid" : requested};
  Result last = Result::error(ErrorCodes::kDeviceNotFound, "no matching CMSIS-DAP device found");
  for (const std::string& name : candidates) {
    std::string error;
    auto candidate = createTransport(name, error);
    if (!candidate) {
      last = Result::error(ErrorCodes::kTransportNotSupported, error);
      if (requested != "auto") return last;
      continue;
    }
    std::vector<DeviceDescriptor> found;
    const Result result = candidate->enumerate(selector, found);
    if (!result.ok) {
      last = result;
      if (requested != "auto") return last;
      continue;
    }
    if (found.empty()) {
      last = Result::error(ErrorCodes::kDeviceNotFound, "no matching CMSIS-DAP device found");
      continue;
    }
    const bool unfiltered = selector.path.empty() && selector.vid.empty() && selector.pid.empty() &&
                            selector.serial.empty() && selector.product.empty();
    if (requested == "auto" && unfiltered) {
      found.erase(std::remove_if(found.begin(), found.end(), [](const DeviceDescriptor& device) {
                    return !isCmsisDapProbeName(device.product) &&
                           !isCmsisDapProbeName(device.manufacturer) &&
                           !isCmsisDapProbeName(device.serial);
                  }), found.end());
      if (found.empty()) continue;
    }
    selected = std::move(candidate);
    devices = std::move(found);
    chosen = name;
    return Result::success();
  }
  if (last.errorCode == ErrorCodes::kDeviceNotFound) {
    chosen = requested == "auto" ? "hid" :
             requested == "cmsis-dap-v2" ? "winusb" :
             requested == "cmsis-dap" ? "hid" : requested;
    return Result::success();
  }
  return last;
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
      "\",\"capabilities\":[\"enumDevices\",\"hidTransport\",\"winusbTransport\",\"dapInfo\",\"dapConnect\","
      "\"dapDisconnect\",\"dapTransfer\",\"dapTransferBlock\",\"swDp\",\"memAp\","
      "\"readMemory\",\"readMemoryBatch\",\"readMemoryBlock\",\"writeMemory\",\"flashAlgorithm\",\"getState\",\"halt\",\"run\","
      "\"reset\",\"stepInstruction\",\"readRegister\",\"hardwareBreakpoints\",\"runToAddress\","
       "\"stepIntoSourceLine\",\"stepOverSourceLine\",\"stepOut\",\"rtt\"]}";
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
  std::unique_ptr<CmsisDapTransport> transport;
  std::string chosenTransport;
  const Result result = enumeratePreferred(transportName, selector, transport, devices, chosenTransport);
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
        ",\"transport\":\"" + jsonEscape(d.transport) + "\""
        ",\"interfaceNumber\":" + std::to_string(d.interfaceNumber) +
        ",\"bulkInEndpoint\":" + std::to_string(d.bulkInEndpoint) +
        ",\"bulkOutEndpoint\":" + std::to_string(d.bulkOutEndpoint) +
        ",\"bulkInMaxPacketSize\":" + std::to_string(d.bulkInMaxPacketSize) +
        ",\"bulkOutMaxPacketSize\":" + std::to_string(d.bulkOutMaxPacketSize) +
        ",\"protocolPacketSize\":" + std::to_string(d.protocolPacketSize) + "}";
  }
  devicesJson += "]";
  return resultJson(true, "enumerated " + std::to_string(devices.size()) + " device(s)",
                    channel.state(), elapsedMs, "{\"devices\":" + devicesJson + "}", "",
                    "{\"transport\":\"" + jsonEscape(chosenTransport) + "\"}");
}

std::string handleOpen(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  if (channel.opened) {
    return resultJson(false, "a device is already open; close it first", channel.state(), 0, "{}",
                      ErrorCodes::kInvalidState);
  }
  std::string transportName = stringField(params, "transport").value_or(channel.requestedTransport);
  if (transportName.empty()) transportName = "hid";
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
  std::unique_ptr<CmsisDapTransport> transport;
  std::string chosenTransport;
  Result result = enumeratePreferred(transportName, selector, transport, devices, chosenTransport);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      "{\"transport\":\"" + jsonEscape(transportName) + "\"}");
  }
  if (devices.empty()) {
      return resultJson(false, "no matching CMSIS-DAP device found", channel.state(), elapsedMs, "{}",
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
  transportName = chosenTransport;
  channel.device = device;
  channel.opened = true;
  channel.connected = false;
  // Clear stale input reports left by a previous session (some firmware does
  // not flush its report buffer on open). Best-effort.
  channel.transport->drainInput(std::chrono::milliseconds(100));
  diag("opened device vid=" + device.vid + " pid=" + device.pid + " product=" + device.product +
       " serial=" + device.serial + " transport=" + chosenTransport + " inputReportLength=" + std::to_string(device.inputReportLength) +
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
          std::to_string(device.reportId) + ",\"transport\":\"" + jsonEscape(transportName) + "\",\"interfaceNumber\":" +
          std::to_string(device.interfaceNumber) + ",\"bulkInEndpoint\":" + std::to_string(device.bulkInEndpoint) +
          ",\"bulkOutEndpoint\":" + std::to_string(device.bulkOutEndpoint) + ",\"bulkInMaxPacketSize\":" +
          std::to_string(device.bulkInMaxPacketSize) + ",\"bulkOutMaxPacketSize\":" +
          std::to_string(device.bulkOutMaxPacketSize) + ",\"protocolPacketSize\":" +
          std::to_string(device.protocolPacketSize) + "}");
}

Result claimFpbOwnership(CmsisDapTarget& target, CortexMDebug& debug,
                         FpbState& fpbState, CortexMDebugState& finalState,
                         DapTransferDiagnostics& diagnostics,
                         std::chrono::milliseconds timeout) {
  CortexMDebugState initialState;
  Result result = debug.getState(initialState, diagnostics, timeout);
  if (!result.ok) return result;

  const bool restoreRunning = !initialState.halted;
  if (restoreRunning) {
    CortexMDebugState haltedState;
    result = debug.halt(haltedState, diagnostics, timeout);
    if (!result.ok) return result;
  }

  FpbBreakpointManager fpb(&target, &fpbState);
  FpbCapabilities capabilities;
  result = fpb.initialize(capabilities, diagnostics, timeout);

  Result restoreResult = Result::success();
  if (restoreRunning) restoreResult = debug.resume(diagnostics, timeout);
  if (!restoreResult.ok) {
    return Result::error(
        "FpbCleanupFailed",
        "failed to restore target state after claiming FPB ownership: " +
            restoreResult.message);
  }
  if (!result.ok) return result;
  return debug.getState(finalState, diagnostics, timeout);
}

void clearFpbBestEffort(Channel& channel) {
  if (!channel.fpbState.initialized || !channel.connected || !channel.transport
      || !channel.transport->isOpen()) {
    channel.clearDebugResourceState();
    return;
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diagnostics;
  const Result power = target.initializeDebugPower(diagnostics, std::chrono::milliseconds(500));
  if (power.ok) {
    FpbBreakpointManager fpb(&target, &channel.fpbState);
    uint32_t cleared = 0;
    const Result cleanup = fpb.clearAll(cleared, diagnostics, std::chrono::milliseconds(500));
    if (!cleanup.ok) diag("FPB cleanup failed code=" + cleanup.errorCode + " message=" + cleanup.message);
  } else {
    diag("FPB cleanup power-up failed code=" + power.errorCode + " message=" + power.message);
  }
  channel.clearDebugResourceState();
}

std::string handleClose(Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  if (channel.transport) {
    if (channel.connected && channel.transport->isOpen()) {
      clearFpbBestEffort(channel);
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
  channel.clearDebugResourceState();
  return resultJson(true, "device closed", "Disconnected", 0);
}

std::string packetSizeSourceName(PacketSizeSource source) {  switch (source) {
    case PacketSizeSource::ProtocolInfo:
      return "protocol-info";
    case PacketSizeSource::HidReportCapability:
      return "hid-report-capability";
    case PacketSizeSource::UsbDescriptor:
      return "usb-descriptor";
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
  channel.clearDebugResourceState();
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
  clearFpbBestEffort(channel);
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
  channel.clearDebugResourceState();
  return resultJson(true, "DAP_Disconnect completed", channel.state(), elapsedMs);
}

// ---------------------------------------------------------------------------
// DAP-03: SW-DP / MEM-AP registers and Cortex-M 32-bit memory reads
// ---------------------------------------------------------------------------

std::string targetDiagnosticsJson(const DapTransferDiagnostics& diag, uint16_t packetSize) {
  const uint32_t blockCount = diag.blockReads + diag.blockWrites;
  const uint32_t transferCount = diag.packets >= blockCount ? diag.packets - blockCount : 0;
  return "{\"chunks\":" + std::to_string(diag.chunks) + ",\"packets\":" +
         std::to_string(diag.packets) + ",\"blockReads\":" + std::to_string(diag.blockReads) +
         ",\"blockWrites\":" + std::to_string(diag.blockWrites) +
         ",\"dapTransferCount\":" + std::to_string(transferCount) +
         ",\"dapTransferBlockCount\":" + std::to_string(blockCount) +
         ",\"waitRetries\":" + std::to_string(diag.waitRetries) +
         ",\"faultClears\":" + std::to_string(diag.faultClears) +
         ",\"packetSize\":" + std::to_string(packetSize) +
         ",\"usbWriteReports\":" + std::to_string(diag.usbWriteReports) +
         ",\"usbReadReports\":" + std::to_string(diag.usbReadReports) +
         ",\"usbReportBytes\":" + std::to_string(diag.usbReportBytes) +
         ",\"protocolPayloadBytes\":" + std::to_string(diag.protocolPayloadBytes) +
         ",\"effectiveReadBytes\":" + std::to_string(diag.effectiveReadBytes) +
         ",\"packedReads\":" + std::to_string(diag.packedReads) +
         ",\"fallbackReads\":" + std::to_string(diag.fallbackReads) +
         ",\"transport\":\"" + jsonEscape(diag.transport) + "\"}";
}

void applyTransportDelta(const TransportIoCounters& before, const TransportIoCounters& after,
                         DapTransferDiagnostics& diag) {
  diag.usbWriteReports = after.writeReports - before.writeReports;
  diag.usbReadReports = after.readReports - before.readReports;
  diag.usbReportBytes = (after.writeReportBytes - before.writeReportBytes) +
                        (after.readReportBytes - before.readReportBytes);
  diag.protocolPayloadBytes = (after.writePayloadBytes - before.writePayloadBytes) +
                              (after.readPayloadBytes - before.readPayloadBytes);
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
  const TransportIoCounters ioBefore = channel.transport->ioCounters();
  const Result result = target.readMemory(static_cast<uint32_t>(*address),
                                          static_cast<uint32_t>(*size), bytes, diag);
  applyTransportDelta(ioBefore, channel.transport->ioCounters(), diag);
  diag.transport = channel.transport->transportName();
  diag.effectiveReadBytes = bytes.size();
  diag.fallbackReads = 1;
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

std::string handleReadMemoryBatch(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const JsonValue* readsValue = params.get("reads");
  const size_t requestBytes = jsonSerialize(params).size();
  if (!readsValue || readsValue->kind != JsonValue::Kind::Array || readsValue->array.empty() ||
      readsValue->array.size() > kMaxMemoryBatchReads ||
      requestBytes > kMaxMemoryBatchRequestBytes) {
    return resultJson(
        false,
        "readMemoryBatch requires reads array in 1.." +
            std::to_string(kMaxMemoryBatchReads) + " and request size <= " +
            std::to_string(kMaxMemoryBatchRequestBytes),
        channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }

  struct BatchRead {
    uint32_t address;
    uint32_t size;
  };
  std::vector<BatchRead> reads;
  reads.reserve(readsValue->array.size());
  uint64_t totalBytes = 0;
  for (size_t index = 0; index < readsValue->array.size(); ++index) {
    const JsonValue& item = readsValue->array[index];
    const std::optional<uint64_t> address = uintField(item, "address");
    const std::optional<uint64_t> size = uintField(item, "size");
    if (item.kind != JsonValue::Kind::Object || !address || *address > 0xFFFFFFFFull ||
        !size || *size == 0 || *size > kMaxMemoryReadBytes ||
        *address + *size > 0x100000000ull || totalBytes + *size > kMaxMemoryBatchBytes) {
      const std::string diagnostics =
          "{\"failedIndex\":" + std::to_string(index) +
          ",\"failedAddress\":" + std::to_string(address.value_or(0)) +
          ",\"completedReads\":0,\"errorCode\":\"" +
          std::string(ErrorCodes::kDapInvalidRequest) + "\"}";
      return resultJson(false,
                        "readMemoryBatch item " + std::to_string(index) +
                            " has an invalid address, size, range, or total byte count",
                        channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest, diagnostics);
    }
    reads.push_back({static_cast<uint32_t>(*address), static_cast<uint32_t>(*size)});
    totalBytes += *size;
  }

  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diagnostics;
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(5000));
  std::vector<std::vector<uint8_t>> results(reads.size());
  size_t completedReadCount = 0;
  const TransportIoCounters ioBefore = channel.transport->ioCounters();
  auto safeScalar = [&reads](size_t index) {
    return reads[index].size == 4 && (reads[index].address & 0x03u) == 0;
  };
  auto contiguousRunEnd = [&reads](size_t start) {
    size_t end = start + 1;
    while (end < reads.size() && reads[end].size == 4 &&
           (reads[end].address & 0x03u) == 0 &&
           reads[end].address == reads[end - 1].address + 4u) {
      ++end;
    }
    return end;
  };
  auto failBatch = [&](size_t failedIndex, const Result& readResult) {
    applyTransportDelta(ioBefore, channel.transport->ioCounters(), diagnostics);
    diagnostics.transport = channel.transport->transportName();
    failedIndex = std::min(failedIndex, reads.size() - 1);
    uint64_t effectiveBytes = 0;
    for (size_t i = 0; i < completedReadCount; ++i) effectiveBytes += results[i].size();
    diagnostics.effectiveReadBytes = effectiveBytes;
    std::string diagnosticJson = targetDiagnosticsJson(diagnostics, channel.packetSize);
    diagnosticJson.pop_back();
    diagnosticJson += ",\"failedIndex\":" + std::to_string(failedIndex) +
                      ",\"failedAddress\":" + std::to_string(reads[failedIndex].address) +
                      ",\"completedReads\":" + std::to_string(completedReadCount) +
                      ",\"errorCode\":\"" + jsonEscape(readResult.errorCode) + "\"}";
    const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
    return resultJson(false,
                      "readMemoryBatch failed at index " + std::to_string(failedIndex) +
                          " address " + hexWord(reads[failedIndex].address) + ": " +
                          readResult.message,
                      channel.state(), elapsedMs, "{}", readResult.errorCode, diagnosticJson);
  };

  size_t index = 0;
  while (index < reads.size()) {
    const size_t runEnd = safeScalar(index) ? contiguousRunEnd(index) : index + 1;
    if (runEnd - index >= 2) {
      std::vector<uint32_t> words;
      const Result readResult = target.readMemoryBlock(
          reads[index].address, static_cast<uint32_t>(runEnd - index), words, diagnostics, timeout);
      if (!readResult.ok) {
        for (size_t word = 0; word < words.size() && index + word < runEnd; ++word) {
          results[index + word] = {
              static_cast<uint8_t>(words[word] & 0xFF), static_cast<uint8_t>((words[word] >> 8) & 0xFF),
              static_cast<uint8_t>((words[word] >> 16) & 0xFF), static_cast<uint8_t>((words[word] >> 24) & 0xFF)};
          ++completedReadCount;
        }
        return failBatch(index + words.size(), readResult);
      }
      for (size_t word = 0; word < words.size(); ++word) {
        results[index + word] = {
            static_cast<uint8_t>(words[word] & 0xFF), static_cast<uint8_t>((words[word] >> 8) & 0xFF),
            static_cast<uint8_t>((words[word] >> 16) & 0xFF), static_cast<uint8_t>((words[word] >> 24) & 0xFF)};
      }
      completedReadCount += words.size();
      diagnostics.fallbackReads += static_cast<uint32_t>(words.size());
      index = runEnd;
      continue;
    }

    if (safeScalar(index)) {
      size_t groupEnd = index + 1;
      while (groupEnd < reads.size() && safeScalar(groupEnd)) {
        if (contiguousRunEnd(groupEnd) - groupEnd >= 2) break;
        ++groupEnd;
      }
      if (groupEnd - index >= 2) {
        std::vector<uint32_t> addresses;
        addresses.reserve(groupEnd - index);
        for (size_t item = index; item < groupEnd; ++item) addresses.push_back(reads[item].address);
        std::vector<uint32_t> values;
        uint32_t packedCompleted = 0;
        const Result readResult = target.readMemoryScattered32(
            addresses, values, packedCompleted, diagnostics, timeout);
        for (size_t item = 0; item < values.size() && index + item < groupEnd; ++item) {
          const uint32_t value = values[item];
          results[index + item] = {
              static_cast<uint8_t>(value & 0xFF), static_cast<uint8_t>((value >> 8) & 0xFF),
              static_cast<uint8_t>((value >> 16) & 0xFF), static_cast<uint8_t>((value >> 24) & 0xFF)};
          ++completedReadCount;
        }
        if (!readResult.ok) return failBatch(index + packedCompleted, readResult);
        index = groupEnd;
        continue;
      }
    }

    std::vector<uint8_t> bytes;
    const Result readResult = target.readMemory(reads[index].address, reads[index].size,
                                                bytes, diagnostics);
    if (!readResult.ok) return failBatch(index, readResult);
    results[index] = std::move(bytes);
    ++completedReadCount;
    ++diagnostics.fallbackReads;
    ++index;
  }
  applyTransportDelta(ioBefore, channel.transport->ioCounters(), diagnostics);
  diagnostics.transport = channel.transport->transportName();
  diagnostics.effectiveReadBytes = totalBytes;
  diagnostics.fallbackReads = std::max(diagnostics.fallbackReads,
                                       static_cast<uint32_t>(reads.size() - diagnostics.packedReads));

  std::string readsJson = "[";
  for (size_t outputIndex = 0; outputIndex < reads.size(); ++outputIndex) {
    if (outputIndex > 0) readsJson += ",";
    readsJson += "{\"address\":" + std::to_string(reads[outputIndex].address) +
                 ",\"size\":" + std::to_string(reads[outputIndex].size) + ",\"bytes\":[";
    for (size_t byteIndex = 0; byteIndex < results[outputIndex].size(); ++byteIndex) {
      if (byteIndex > 0) readsJson += ",";
      readsJson += std::to_string(results[outputIndex][byteIndex]);
    }
    readsJson += "]}";
  }
  readsJson += "]";
  std::string diagnosticJson = targetDiagnosticsJson(diagnostics, channel.packetSize);
  diagnosticJson.pop_back();
  diagnosticJson += ",\"completedReads\":" + std::to_string(reads.size()) + "}";
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  return resultJson(true, "memory batch read", channel.state(), elapsedMs,
                    "{\"reads\":" + readsJson + "}", "", diagnosticJson);
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

std::string handleWriteMemory(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const std::optional<uint64_t> address = uintField(params, "address");
  const std::optional<std::vector<uint8_t>> bytes =
      byteArrayField(params, "bytes", kMaxMemoryWriteBytes);
  if (!address || *address > 0xFFFFFFFF || !bytes || bytes->empty()) {
    return resultJson(false,
                      "writeMemory requires a 32-bit address and bytes in 1.." +
                          std::to_string(kMaxMemoryWriteBytes),
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest);
  }
  const std::chrono::milliseconds timeout(uintField(params, "timeoutMs").value_or(5000));
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  DapTransferDiagnostics diag;
  const Result result = target.writeMemory(static_cast<uint32_t>(*address), *bytes, diag, timeout);
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}", result.errorCode,
                      targetDiagnosticsJson(diag, channel.packetSize));
  }
  return resultJson(true, "memory written", channel.state(), elapsedMs,
                    "{\"address\":" + std::to_string(*address) +
                        ",\"bytesWritten\":" + std::to_string(bytes->size()) + "}",
                    "", targetDiagnosticsJson(diag, channel.packetSize));
}

class CmsisDapRttMemory final : public RttMemory {
 public:
  CmsisDapRttMemory(CmsisDapTarget& target, std::chrono::milliseconds timeout)
      : target_(target), timeout_(timeout) {}

  Result read(uint32_t address, uint32_t size, std::vector<uint8_t>& bytes,
              DapTransferDiagnostics& diagnostics) override {
    return target_.readMemory(address, size, bytes, diagnostics);
  }

  Result write(uint32_t address, const std::vector<uint8_t>& bytes,
               DapTransferDiagnostics& diagnostics) override {
    return target_.writeMemory(address, bytes, diagnostics, timeout_);
  }

 private:
  CmsisDapTarget& target_;
  std::chrono::milliseconds timeout_;
};

std::optional<uint32_t> controlTimeoutMs(const JsonValue& params);

std::string rttReadDataJson(const RttReadResult& output) {
  std::string bytesJson = "[";
  for (size_t i = 0; i < output.bytes.size(); ++i) {
    if (i > 0) bytesJson += ",";
    bytesJson += std::to_string(output.bytes[i]);
  }
  bytesJson += "]";
  return "{\"bytes\":" + bytesJson +
      ",\"controlBlockAddress\":" + std::to_string(output.controlBlockAddress) +
      ",\"bufferIndex\":" + std::to_string(output.bufferIndex) +
      ",\"descriptorAddress\":" + std::to_string(output.descriptorAddress) +
      ",\"bufferAddress\":" + std::to_string(output.bufferAddress) +
      ",\"bufferSize\":" + std::to_string(output.bufferSize) +
      ",\"wrOff\":" + std::to_string(output.wrOff) +
      ",\"rdOff\":" + std::to_string(output.rdOff) +
      ",\"flags\":" + std::to_string(output.flags) +
      ",\"mode\":" + std::to_string(output.mode) +
      ",\"committedRdOff\":" + std::to_string(output.committedRdOff) +
      ",\"requestedBytes\":" + std::to_string(output.requestedBytes) +
      ",\"readBytes\":" + std::to_string(output.readBytes) +
      ",\"committedBytes\":" + std::to_string(output.committedBytes) +
      ",\"wrapped\":" + std::string(output.wrapped ? "true" : "false") +
      ",\"overrun\":" + std::string(output.overrun ? "true" : "false") +
      ",\"writerAdvanced\":" + std::string(output.writerAdvanced ? "true" : "false") + "}";
}

std::string rttDiagnosticsJson(const DapTransferDiagnostics& diagnostics, uint16_t packetSize,
                               const RttReadResult* output = nullptr,
                               const std::string& extra = "") {
  std::string json = targetDiagnosticsJson(diagnostics, packetSize);
  json.pop_back();
  if (output) json += ",\"rtt\":" + rttReadDataJson(*output);
  if (!extra.empty()) json += "," + extra;
  json += "}";
  return json;
}

std::string handleStartRtt(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result ready = channel.ensureReady();
  if (!ready.ok) {
    return resultJson(false, ready.message, channel.state(), 0, "{}", ready.errorCode,
                      "{\"operation\":\"startRtt\"}");
  }
  const auto address = uintField(params, "controlBlockAddress");
  const auto timeout = controlTimeoutMs(params);
  if (!address || *address == 0 || *address > 0xFFFFFFFFull || !timeout) {
    return resultJson(false, "startRtt requires controlBlockAddress and timeoutMs", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest, "{\"operation\":\"startRtt\"}");
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CmsisDapRttMemory memory(target, std::chrono::milliseconds(*timeout));
  DapTransferDiagnostics diagnostics;
  const Result result = channel.rttReader.start(memory, static_cast<uint32_t>(*address), diagnostics);
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  const std::string extra = "\"operation\":\"startRtt\",\"controlBlockAddress\":" +
      std::to_string(*address);
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}",
                      result.errorCode, rttDiagnosticsJson(diagnostics, channel.packetSize, nullptr, extra));
  }
  return resultJson(true, "RTT started", channel.state(), elapsedMs,
                    "{\"controlBlockAddress\":" + std::to_string(*address) + "}", "",
                    rttDiagnosticsJson(diagnostics, channel.packetSize, nullptr, extra));
}

std::string handleStopRtt(Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const bool wasStarted = channel.rttReader.started();
  channel.rttReader.stop();
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  return resultJson(true, wasStarted ? "RTT stopped" : "RTT already stopped",
                    channel.state(), elapsedMs, "{\"started\":false}");
}

std::string handleReadRtt(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  if (!channel.rttReader.started()) {
    return resultJson(false, "RTT is not started", channel.state(), 0, "{}",
                      ErrorCodes::kRttStopped, "{\"operation\":\"readRtt\"}");
  }
  const Result ready = channel.ensureReady();
  if (!ready.ok) {
    return resultJson(false, ready.message, channel.state(), 0, "{}",
                      ErrorCodes::kRttOwnerLost, "{\"operation\":\"readRtt\",\"cause\":\"" +
                          jsonEscape(ready.errorCode) + "\"}");
  }
  const auto bufferIndex = uintField(params, "bufferIndex");
  const auto size = uintField(params, "size");
  const auto timeout = controlTimeoutMs(params);
  if (!bufferIndex || *bufferIndex > 0xFFFFFFFFull || !size || *size == 0 ||
      *size > 65536 || !timeout) {
    return resultJson(false, "readRtt requires bufferIndex and size in 1..65536", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest, "{\"operation\":\"readRtt\"}");
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CmsisDapRttMemory memory(target, std::chrono::milliseconds(*timeout));
  DapTransferDiagnostics diagnostics;
  RttReadResult output;
  const Result result = channel.rttReader.read(memory, static_cast<uint32_t>(*bufferIndex),
                                               static_cast<uint32_t>(*size), output, diagnostics);
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  const std::string extra = "\"operation\":\"readRtt\"";
  if (!result.ok) {
    return resultJson(false, result.message, channel.state(), elapsedMs, "{}",
                      result.errorCode, rttDiagnosticsJson(diagnostics, channel.packetSize, &output, extra));
  }
  return resultJson(true, output.bytes.empty() ? "RTT empty read" : "RTT read",
                    channel.state(), elapsedMs, rttReadDataJson(output), "",
                    rttDiagnosticsJson(diagnostics, channel.packetSize, &output, extra));
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

// Halt/step/breakpoint control stays bounded at 10 s so a stuck core cannot
// pin the helper. Flash Algorithm operations (especially 128 KiB H7 sector
// erase) need a longer ceiling; 60 s covers the STM32H723 defaults of
// eraseTimeoutMs=30000 / programTimeoutMs=15000 with headroom.
constexpr uint64_t kControlTimeoutMaxMs = 10000;
constexpr uint64_t kFlashAlgorithmTimeoutMaxMs = 60000;

std::optional<uint32_t> boundedTimeoutMs(const JsonValue& params, uint64_t maxMs) {
  const uint64_t timeout = uintField(params, "timeoutMs").value_or(1000);
  if (timeout == 0 || timeout > maxMs) return std::nullopt;
  return static_cast<uint32_t>(timeout);
}

std::optional<uint32_t> controlTimeoutMs(const JsonValue& params) {
  return boundedTimeoutMs(params, kControlTimeoutMaxMs);
}

std::optional<uint32_t> flashAlgorithmTimeoutMs(const JsonValue& params) {
  return boundedTimeoutMs(params, kFlashAlgorithmTimeoutMaxMs);
}

std::string coreFailure(const Result& result, const char* operation, Channel& channel,
                        const std::chrono::steady_clock::time_point& started,
                        uint32_t timeoutMs, const DapTransferDiagnostics& diag,
                        const std::string& extra = "",
                        const CortexMDebugDiagnostics* algorithm = nullptr,
                        const std::string& dataJson = "{}");
std::string invalidControlTimeout(const char* operation, Channel& channel);

std::string handleFlashAlgorithm(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    channel.clearFlashAlgorithmState();
    return resultJson(false, readyResult.message, channel.state(), 0, "{}", readyResult.errorCode);
  }
  const auto timeout = flashAlgorithmTimeoutMs(params);
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
  // Optional target Flash diagnostic registers. Absent fields keep the
  // STM32F407 defaults so existing sessions observe no protocol change; the
  // two registers must be adjacent aligned words because both are fetched in
  // one 2-word block read starting at the lower address.
  const auto flashStatusAddressOpt = uintField(params, "flashStatusAddress");
  const auto flashControlAddressOpt = uintField(params, "flashControlAddress");
  const uint32_t flashStatusAddress =
      static_cast<uint32_t>(flashStatusAddressOpt.value_or(kStm32F4FlashSr));
  const uint32_t flashControlAddress =
      static_cast<uint32_t>(flashControlAddressOpt.value_or(kStm32F4FlashCr));
  const auto flashDiagParamsValid = (!flashStatusAddressOpt || flashStatusAddressOpt <= 0xFFFFFFFFu)
      && (!flashControlAddressOpt || flashControlAddressOpt <= 0xFFFFFFFFu)
      && (flashStatusAddress % 4u) == 0u && (flashControlAddress % 4u) == 0u
      && (flashStatusAddress > flashControlAddress
              ? flashStatusAddress - flashControlAddress
              : flashControlAddress - flashStatusAddress) == 4u;
  // Optional loader RAM window for the algorithm image, page buffer, and
  // stack. Absent fields keep the STM32F407 128 KiB SRAM defaults.
  const auto ramBaseOpt = uintField(params, "ramBase");
  const auto ramSizeOpt = uintField(params, "ramSize");
  const auto ramWindowParamsValid = (!ramBaseOpt || (ramBaseOpt <= 0xFFFFFFFFu && *ramBaseOpt % 4u == 0u))
      && (!ramSizeOpt || *ramSizeOpt > 0u)
      && (!ramBaseOpt || !ramSizeOpt
          || (*ramBaseOpt <= 0xFFFFFFFFu - *ramSizeOpt && *ramSizeOpt <= 0x10000000u));
  const JsonValue* reusePageBufferValue = params.get("reusePageBuffer");
  const auto reusePageBuffer = boolField(params, "reusePageBuffer");
  if (!operation || (*operation != "init" && *operation != "uninit" && *operation != "eraseSector" &&
                    *operation != "programPage" && *operation != "verify") || !code || code->empty() ||
      !data || !algorithmAddress || !entry || !bkptAddress || !stackPointer || !pageBufferAddress ||
      !targetAddress || !size || *algorithmAddress > 0xFFFFFFFFu || *entry > 0xFFFFFFFFu ||
      *bkptAddress > 0xFFFFFFFFu || *stackPointer > 0xFFFFFFFFu || *pageBufferAddress > 0xFFFFFFFFu ||
      stackSize > 0xFFFFFFFFu || staticBase > 0xFFFFFFFFu || *targetAddress > 0xFFFFFFFFu ||
      (*size > 0x10000u && *operation != "eraseSector") ||
      (*operation == "eraseSector" && *size > 0x100000u) || clockHz > 0xFFFFFFFFu ||
      !flashDiagParamsValid || !ramWindowParamsValid ||
      (reusePageBufferValue && !reusePageBuffer.has_value()) ||
      ((*operation == "programPage" || *operation == "verify") && data->size() < *size)) {
    return resultJson(false, "flashAlgorithm parameters are invalid", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest,
                      "{\"operation\":\"flashAlgorithm\"}");
  }

  // Both diagnostic registers are fetched in a single 2-word block read
  // starting at the lower address (STM32F4: [SR, CR]; H723: [CR1, SR1]).
  const uint32_t flashDiagBase =
      flashStatusAddress < flashControlAddress ? flashStatusAddress : flashControlAddress;
  const uint32_t flashStatusIndex = (flashStatusAddress - flashDiagBase) / 4u;
  const uint32_t flashControlIndex = (flashControlAddress - flashDiagBase) / 4u;

  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diag;
  const Result powerResult =
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
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
  request.ramBase = static_cast<uint32_t>(ramBaseOpt.value_or(0x20000000u));
  request.ramSize = static_cast<uint32_t>(ramSizeOpt.value_or(0x20000u));
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
  const Result flashBeforeResult = target.readMemoryBlock(flashDiagBase, 2, flashRegistersBefore, diag,
                                                          std::chrono::milliseconds(*timeout));
  const bool flashRegistersBeforeValid = flashBeforeResult.ok && flashRegistersBefore.size() == 2;
  const uint32_t flashStatusBefore = flashRegistersBeforeValid ? flashRegistersBefore[flashStatusIndex] : 0;
  const uint32_t flashControlBefore = flashRegistersBeforeValid ? flashRegistersBefore[flashControlIndex] : 0;
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
  const Result flashRegisterResult = target.readMemoryBlock(flashDiagBase, 2, flashRegisters, diag,
                                                            std::chrono::milliseconds(*timeout));
  const bool flashRegistersValid = flashRegisterResult.ok && flashRegisters.size() == 2;
  const uint32_t flashStatus = flashRegistersValid ? flashRegisters[flashStatusIndex] : 0;
  const uint32_t flashControl = flashRegistersValid ? flashRegisters[flashControlIndex] : 0;
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
                        const CortexMDebugDiagnostics* algorithm,
                        const std::string& dataJson) {
  channel.debugPowerReady = false;
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
  return resultJson(false, result.message, channel.state(), elapsedMs, dataJson,
                    result.errorCode.empty() ? ErrorCodes::kInternalError : result.errorCode,
                    cortexDiagnosticsJson(operation, timeoutMs, diag, extra, algorithm));
}

std::string invalidControlTimeout(const char* operation, Channel& channel) {
  const uint64_t maxMs = std::string(operation) == "flashAlgorithm"
      ? kFlashAlgorithmTimeoutMaxMs
      : kControlTimeoutMaxMs;
  return resultJson(false,
                    "timeoutMs must be an integer in 1.." + std::to_string(maxMs),
                    channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest,
                    "{\"operation\":\"" + std::string(operation) + "\",\"field\":\"timeoutMs\"}");
}

std::string uintArrayJson(const std::vector<uint32_t>& values) {
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < values.size(); ++index) {
    if (index != 0) out << ',';
    out << values[index];
  }
  out << ']';
  return out.str();
}

std::string fpbCapabilitiesJson(const FpbCapabilities& capabilities) {
  return "{\"fpCtrl\":" + std::to_string(capabilities.fpCtrl) +
         ",\"revision\":" + std::to_string(capabilities.revision) +
         ",\"codeComparators\":" + std::to_string(capabilities.codeComparators) +
         ",\"literalComparators\":" + std::to_string(capabilities.literalComparators) +
         ",\"enabled\":" + (capabilities.enabled ? "true" : "false") + "}";
}

std::string fpbBreakpointJson(const FpbBreakpointResult& breakpoint,
                              const FpbCapabilities& capabilities) {
  return "{\"slot\":" + std::to_string(breakpoint.slot) +
         ",\"requestedAddress\":" + std::to_string(breakpoint.requestedAddress) +
         ",\"address\":" + std::to_string(breakpoint.address) +
         ",\"fpbRevision\":" + std::to_string(capabilities.revision) +
         ",\"codeComparators\":" + std::to_string(capabilities.codeComparators) +
         ",\"comparatorValue\":" + std::to_string(breakpoint.comparatorValue) +
         ",\"comparatorReadback\":" + std::to_string(breakpoint.comparatorReadback) +
         ",\"duplicate\":" + (breakpoint.duplicate ? "true" : "false") + "}";
}

Result prepareFpbWrite(CortexMDebug& debug, CortexMDebugState& initial,
                       bool& restoreRunning, DapTransferDiagnostics& diagnostics,
                       std::chrono::milliseconds timeout) {
  Result result = debug.getState(initial, diagnostics, timeout);
  if (!result.ok) return result;
  restoreRunning = !initial.halted;
  if (!restoreRunning) return Result::success();
  CortexMDebugState halted;
  return debug.halt(halted, diagnostics, timeout);
}

Result finishFpbWrite(CortexMDebug& debug, bool restoreRunning,
                      CortexMDebugState& finalState,
                      DapTransferDiagnostics& diagnostics,
                      std::chrono::milliseconds timeout) {
  if (restoreRunning) {
    Result result = debug.resume(diagnostics, timeout);
    if (!result.ok) return result;
  }
  return debug.getState(finalState, diagnostics, timeout);
}

std::string sourceStepJson(const SourceStepResult& step) {
  std::ostringstream out;
  out << "{\"pcBefore\":" << step.pcBefore << ",\"pcAfter\":" << step.pcAfter
      << ",\"classification\":\"" << jsonEscape(step.classification) << "\""
      << ",\"stopReason\":\"" << jsonEscape(step.stopReason) << "\""
      << ",\"instructions\":" << step.instructions
      << ",\"cleanupOk\":" << (step.cleanupOk ? "true" : "false")
      << ",\"enteredCall\":" << (step.enteredCall ? "true" : "false")
      << ",\"instructionRetired\":" << (step.instructionRetired ? "true" : "false")
      << ",\"interruptMaskApplied\":" << (step.interruptMaskApplied ? "true" : "false")
      << ",\"interruptMaskCleared\":" << (step.interruptMaskCleared ? "true" : "false")
      << ",\"stepDhcsr\":" << step.stepDhcsr
      << ",\"stepDhcsrPolls\":" << step.stepDhcsrPolls
      << ",\"temporaryBreakpointCount\":" << step.temporaryBreakpointCount
      << ",\"restoredSlots\":" << uintArrayJson(step.restoredSlots);
  if (step.temporarySlot) out << ",\"temporarySlot\":" << *step.temporarySlot;
  if (step.returnAddress) out << ",\"returnAddress\":" << *step.returnAddress;
  if (step.lr) out << ",\"lr\":" << *step.lr;
  if (step.sp) out << ",\"sp\":" << *step.sp;
  out << ",\"trace\":[";
  for (size_t index = 0; index < step.trace.size(); ++index) {
    if (index != 0) out << ',';
    out << "{\"pc\":" << step.trace[index].pc
        << ",\"classification\":\"" << jsonEscape(step.trace[index].classification)
        << "\",\"call\":" << (step.trace[index].call ? "true" : "false") << '}';
  }
  out << "],\"timings\":{\"haltMs\":0,\"readPcMs\":0,\"decodeMs\":0,"
      << "\"executeMs\":0,\"waitMs\":0,\"cleanupMs\":0,\"totalMs\":0}}";
  return out.str();
}

std::string startupStopJson(const StartupStopResult& startup) {
  std::ostringstream out;
  out << "{\"requestedAddress\":" << startup.requestedAddress
      << ",\"entryAddress\":" << startup.entryAddress
      << ",\"resetRequested\":" << (startup.resetRequested ? "true" : "false")
      << ",\"resetPcValid\":" << (startup.resetPcValid ? "true" : "false")
      << ",\"resetDhcsr\":" << startup.resetDhcsr
      << ",\"resetPc\":" << startup.resetPc
      << ",\"resetLr\":" << startup.resetLr
      << ",\"pc\":" << startup.pc
      << ",\"lr\":" << startup.lr
      << ",\"dhcsr\":" << startup.dhcsr
      << ",\"cleanupOk\":" << (startup.cleanupOk ? "true" : "false")
      << ",\"sharedUserSlot\":" << (startup.sharedUserSlot ? "true" : "false")
      << ",\"temporaryBreakpointCount\":" << startup.temporaryBreakpointCount;
  if (startup.temporarySlot) {
    out << ",\"temporarySlot\":" << *startup.temporarySlot;
  }
  out << ",\"ignoredUserSlots\":" << uintArrayJson(startup.ignoredUserSlots)
      << "}";
  return out.str();
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
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
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
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
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
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "run", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CortexMDebugState state;
  Result result = debug.getState(state, diag, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "run", channel, started, *timeout, diag);
  SourceStepResult currentBreakpointStep;
  bool steppedCurrentBreakpoint = false;
  if (state.halted && state.pcValid && channel.fpbState.initialized) {
    steppedCurrentBreakpoint = std::any_of(
        channel.fpbState.userSlots.begin(), channel.fpbState.userSlots.end(),
        [&](const auto& address) { return address && *address == (state.pc & ~1u); });
    if (steppedCurrentBreakpoint) {
      CmsisDapSourceStepper stepper(&target, &debug, &channel.fpbState);
      result = stepper.stepInstruction(currentBreakpointStep, diag,
                                       std::chrono::milliseconds(*timeout));
      if (!result.ok) {
        return coreFailure(result, "run", channel, started, *timeout, diag,
                           "\"phase\":\"continueAtCurrentPc\",\"step\":" +
                               sourceStepJson(currentBreakpointStep));
      }
    }
  }
  result = debug.run(state, diag, std::chrono::milliseconds(*timeout));
  bool breakpointHitBeforeRunningObserved = false;
  if (!result.ok && result.errorCode == ErrorCodes::kDapControlTimeout &&
      channel.fpbState.initialized) {
    // A nearby FPB comparator can halt the core before the HID polling loop
    // observes even one Running sample. The resume write completed, so confirm
    // the current owner is halted at an actually configured user comparator.
    // Do not turn unrelated halts, lockups, or unreadable state into success.
    CortexMDebugState immediateState;
    const Result stateResult =
        debug.getState(immediateState, diag, std::chrono::milliseconds(*timeout));
    if (stateResult.ok && immediateState.halted && immediateState.pcValid) {
      const uint32_t haltedPc = immediateState.pc & ~1u;
      breakpointHitBeforeRunningObserved = std::any_of(
          channel.fpbState.userSlots.begin(), channel.fpbState.userSlots.end(),
          [&](const auto& address) { return address && *address == haltedPc; });
      if (breakpointHitBeforeRunningObserved) {
        state = immediateState;
        result = Result::success();
      }
    }
  }
  if (!result.ok) {
    const std::string stepDiagnostics = steppedCurrentBreakpoint
        ? ",\"phase\":\"resumeAfterCurrentPcStep\",\"step\":" +
              sourceStepJson(currentBreakpointStep)
        : "";
    return coreFailure(result, "run", channel, started, *timeout, diag,
                       "\"dhcsrWrite\":" +
                           std::to_string(kCoreDebugDbgKey | kCoreDebugCDebugEn) +
                           stepDiagnostics);
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  std::string data = "{\"state\":\"" + cortexStateName(state) + "\",\"dhcsr\":" +
                     std::to_string(state.dhcsr);
  if (breakpointHitBeforeRunningObserved) {
    data += ",\"pc\":" + std::to_string(state.pc) +
            ",\"breakpointHitBeforeRunningObserved\":true";
  }
  if (steppedCurrentBreakpoint) {
    data += ",\"pcBefore\":" + std::to_string(currentBreakpointStep.pcBefore) +
            ",\"pcAfterStep\":" + std::to_string(currentBreakpointStep.pcAfter) +
            ",\"instructionRetired\":" +
                (currentBreakpointStep.instructionRetired ? "true" : "false") +
            ",\"interruptMaskApplied\":" +
                (currentBreakpointStep.interruptMaskApplied ? "true" : "false") +
            ",\"interruptMaskCleared\":" +
                (currentBreakpointStep.interruptMaskCleared ? "true" : "false") +
            ",\"stepDhcsr\":" + std::to_string(currentBreakpointStep.stepDhcsr) +
            ",\"stepDhcsrPolls\":" +
                std::to_string(currentBreakpointStep.stepDhcsrPolls) +
            ",\"restoredSlots\":" + uintArrayJson(currentBreakpointStep.restoredSlots);
  }
  data += "}";
  return resultJson(true, "Cortex-M run confirmed", cortexStateName(state), elapsedMs,
                    data,
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
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
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

std::string handleRunToAddress(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result readyResult = channel.ensureReady();
  if (!readyResult.ok) {
    return coreFailure(readyResult, "runToAddress", channel, started, 0, {});
  }
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("runToAddress", channel);
  const auto address = uintField(params, "address");
  if (!address || *address > 0xFFFFFFFFull) {
    return resultJson(false, "runToAddress requires a uint32 address",
                      channel.state(), 0, "{}", ErrorCodes::kDapInvalidRequest,
                      "{\"operation\":\"runToAddress\"}");
  }
  const bool reset = boolField(params, "reset").value_or(true);
  if (reset) channel.clearFlashAlgorithmState();

  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diagnostics;
  Result result = ensureDebugPower(channel, target, diagnostics,
                                   std::chrono::milliseconds(*timeout));
  if (!result.ok) {
    return coreFailure(result, "runToAddress", channel, started, *timeout,
                       diagnostics, "\"phase\":\"debugPower\"");
  }

  CmsisDapStartupStop startupStop(&target, &debug, &channel.fpbState);
  StartupStopResult startup;
  result = startupStop.runToAddress(static_cast<uint32_t>(*address), reset,
                                    startup, diagnostics,
                                    std::chrono::milliseconds(*timeout));
  const std::string startupJson = startupStopJson(startup);
  if (!result.ok) {
    return coreFailure(result, "runToAddress", channel, started, *timeout,
                       diagnostics, "\"startup\":" + startupJson);
  }

  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M startup entry reached and temporary breakpoint cleaned",
                    "Halted", elapsedMs,
                    "{\"state\":\"Halted\"," + startupJson.substr(1), "",
                    cortexDiagnosticsJson("runToAddress", *timeout, diagnostics,
                                          "\"startup\":" + startupJson));
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
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
  if (!powerResult.ok) {
    return coreFailure(powerResult, "stepInstruction", channel, started, *timeout, diag,
                       "\"phase\":\"debugPower\"");
  }
  CmsisDapSourceStepper stepper(&target, &debug, &channel.fpbState);
  SourceStepResult step;
  const Result result = stepper.stepInstruction(step, diag, std::chrono::milliseconds(*timeout));
  const std::string stepJson = sourceStepJson(step);
  if (!result.ok) {
    return coreFailure(result, "stepInstruction", channel, started, *timeout, diag,
                       "\"step\":" + stepJson);
  }
  const long long elapsedMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count();
  return resultJson(true, "Cortex-M instruction step confirmed", "Halted", elapsedMs,
                    "{\"state\":\"Halted\"," + stepJson.substr(1),
                    "",
                    cortexDiagnosticsJson("stepInstruction", *timeout, diag,
                                          "\"step\":" + stepJson));
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
      ensureDebugPower(channel, target, diag, std::chrono::milliseconds(*timeout));
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

std::string handleGetFpbInfo(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result ready = channel.ensureReady();
  if (!ready.ok) return coreFailure(ready, "getFpbInfo", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("getFpbInfo", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diagnostics;
  Result result =
      ensureDebugPower(channel, target, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "getFpbInfo", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"debugPower\"");
  CortexMDebugState finalState;
  result = claimFpbOwnership(target, debug, channel.fpbState, finalState,
                             diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "getFpbInfo", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"claimFpbOwnership\"");
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  const FpbCapabilities& capabilities = channel.fpbState.capabilities;
  const std::string data = fpbCapabilitiesJson(capabilities);
  return resultJson(true, "Cortex-M FPB capability detected", cortexStateName(finalState), elapsedMs,
                    data, "", cortexDiagnosticsJson("getFpbInfo", *timeout, diagnostics,
                                                     "\"fpb\":" + data));
}

std::string handleSetBreakpoint(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result ready = channel.ensureReady();
  if (!ready.ok) return coreFailure(ready, "setBreakpoint", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("setBreakpoint", channel);
  const auto address = uintField(params, "address");
  if (!address || *address > 0xFFFFFFFFull) {
    return resultJson(false, "setBreakpoint requires a uint32 address", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest, "{\"operation\":\"setBreakpoint\"}");
  }
  const auto preferred = uintField(params, "preferredSlot");
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diagnostics;
  Result result =
      ensureDebugPower(channel, target, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "setBreakpoint", channel, started, *timeout, diagnostics);
  CortexMDebugState initialState;
  bool restoreRunning = false;
  result = prepareFpbWrite(debug, initialState, restoreRunning, diagnostics,
                           std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "setBreakpoint", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"prepareFpbWrite\"");
  FpbBreakpointManager fpb(&target, &channel.fpbState);
  FpbBreakpointResult breakpoint;
  result = fpb.setUser(static_cast<uint32_t>(*address),
                       preferred && *preferred <= 0xFFFFFFFFull
                           ? std::optional<uint32_t>(static_cast<uint32_t>(*preferred))
                           : std::nullopt,
                       breakpoint, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "setBreakpoint", channel, started, *timeout, diagnostics,
                                     "\"address\":" + std::to_string(*address));
  CortexMDebugState finalState;
  result = finishFpbWrite(debug, restoreRunning, finalState, diagnostics,
                          std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "setBreakpoint", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"restoreTargetState\"");
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  const std::string data = fpbBreakpointJson(breakpoint, channel.fpbState.capabilities);
  return resultJson(true, "FPB breakpoint set and verified", cortexStateName(finalState), elapsedMs, data, "",
                    cortexDiagnosticsJson("setBreakpoint", *timeout, diagnostics,
                                          "\"breakpoint\":" + data));
}

std::string handleClearBreakpoint(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result ready = channel.ensureReady();
  if (!ready.ok) return coreFailure(ready, "clearBreakpoint", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("clearBreakpoint", channel);
  auto slotValue = uintField(params, "slot");
  if (!slotValue) slotValue = uintField(params, "id");
  if (!slotValue || *slotValue > 0xFFFFFFFFull) {
    return resultJson(false, "clearBreakpoint requires a comparator slot", channel.state(), 0, "{}",
                      ErrorCodes::kDapInvalidRequest);
  }
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diagnostics;
  Result result =
      ensureDebugPower(channel, target, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearBreakpoint", channel, started, *timeout, diagnostics);
  CortexMDebugState initialState;
  bool restoreRunning = false;
  result = prepareFpbWrite(debug, initialState, restoreRunning, diagnostics,
                           std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearBreakpoint", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"prepareFpbWrite\"");
  FpbBreakpointManager fpb(&target, &channel.fpbState);
  FpbBreakpointResult breakpoint;
  result = fpb.clearUser(static_cast<uint32_t>(*slotValue), breakpoint, diagnostics,
                         std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearBreakpoint", channel, started, *timeout, diagnostics,
                                     "\"slot\":" + std::to_string(*slotValue));
  CortexMDebugState finalState;
  result = finishFpbWrite(debug, restoreRunning, finalState, diagnostics,
                          std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearBreakpoint", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"restoreTargetState\"");
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  const std::string data = fpbBreakpointJson(breakpoint, channel.fpbState.capabilities);
  return resultJson(true, "FPB breakpoint cleared and verified", cortexStateName(finalState), elapsedMs, data, "",
                    cortexDiagnosticsJson("clearBreakpoint", *timeout, diagnostics,
                                          "\"breakpoint\":" + data));
}

std::string handleClearAllBreakpoints(const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result ready = channel.ensureReady();
  if (!ready.ok) return coreFailure(ready, "clearAllBreakpoints", channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout("clearAllBreakpoints", channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diagnostics;
  Result result =
      ensureDebugPower(channel, target, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearAllBreakpoints", channel, started, *timeout, diagnostics);
  CortexMDebugState initialState;
  bool restoreRunning = false;
  result = prepareFpbWrite(debug, initialState, restoreRunning, diagnostics,
                           std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearAllBreakpoints", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"prepareFpbWrite\"");
  FpbBreakpointManager fpb(&target, &channel.fpbState);
  FpbCapabilities capabilities;
  result = fpb.initialize(capabilities, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearAllBreakpoints", channel, started, *timeout, diagnostics);
  uint32_t cleared = 0;
  result = fpb.clearAll(cleared, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearAllBreakpoints", channel, started, *timeout, diagnostics);
  CortexMDebugState finalState;
  result = finishFpbWrite(debug, restoreRunning, finalState, diagnostics,
                          std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, "clearAllBreakpoints", channel, started, *timeout, diagnostics,
                                     "\"phase\":\"restoreTargetState\"");
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  const std::string data = "{\"cleared\":" + std::to_string(cleared) +
      ",\"enabled\":false,\"fpbRevision\":" + std::to_string(capabilities.revision) +
      ",\"codeComparators\":" + std::to_string(capabilities.codeComparators) + "}";
  return resultJson(true, "all FPB breakpoints cleared", cortexStateName(finalState), elapsedMs, data, "",
                    cortexDiagnosticsJson("clearAllBreakpoints", *timeout, diagnostics,
                                          "\"fpb\":" + data));
}

std::string handleSourceStep(const char* operation, const JsonValue& params, Channel& channel) {
  const auto started = std::chrono::steady_clock::now();
  const Result ready = channel.ensureReady();
  if (!ready.ok) return coreFailure(ready, operation, channel, started, 0, {});
  const auto timeout = controlTimeoutMs(params);
  if (!timeout) return invalidControlTimeout(operation, channel);
  CmsisDapProtocol protocol(channel.transport.get());
  protocol.setEffectivePacketSize(channel.packetSize);
  CmsisDapTarget target(&protocol, channel.packetSize);
  CortexMDebug debug(&target);
  DapTransferDiagnostics diagnostics;
  Result result =
      ensureDebugPower(channel, target, diagnostics, std::chrono::milliseconds(*timeout));
  if (!result.ok) return coreFailure(result, operation, channel, started, *timeout, diagnostics);
  CmsisDapSourceStepper stepper(&target, &debug, &channel.fpbState);
  SourceStepResult step;
  if (std::string(operation) == "stepIntoSourceLine") {
    result = stepper.stepInto(static_cast<uint32_t>(uintField(params, "lineStart").value_or(0)),
                              static_cast<uint32_t>(uintField(params, "lineEnd").value_or(0)),
                              static_cast<uint32_t>(uintField(params, "maxInstructionSteps").value_or(32)),
                              step, diagnostics, std::chrono::milliseconds(*timeout));
  } else if (std::string(operation) == "stepOverSourceLine") {
    result = stepper.stepOver(static_cast<uint32_t>(uintField(params, "lineStart").value_or(0)),
                              static_cast<uint32_t>(uintField(params, "lineEnd").value_or(0)),
                              static_cast<uint32_t>(uintField(params, "maxInstructionSteps").value_or(128)),
                              step, diagnostics, std::chrono::milliseconds(*timeout));
  } else {
    const uint32_t functionStart = static_cast<uint32_t>(uintField(params, "functionStart").value_or(0));
    const uint32_t functionEnd = static_cast<uint32_t>(uintField(params, "functionEnd").value_or(0));
    if (functionStart == 0 || functionEnd <= functionStart) {
      return resultJson(false, "stepOut requires a non-empty function range", "Halted", 0, "{}",
                        ErrorCodes::kDapInvalidRequest);
    }
    result = stepper.stepOut(functionStart, functionEnd, step, diagnostics,
                             std::chrono::milliseconds(*timeout));
  }
  const std::string stepJson = sourceStepJson(step);
  if (!result.ok) return coreFailure(result, operation, channel, started, *timeout, diagnostics,
                                     "\"step\":" + stepJson, nullptr, stepJson);
  const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  return resultJson(true, std::string("CMSIS-DAP ") + operation + " completed", "Halted",
                    elapsedMs, stepJson, "",
                    cortexDiagnosticsJson(operation, *timeout, diagnostics,
                                          "\"step\":" + stepJson));
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
    // Shutdown is a lifecycle boundary, not just a protocol acknowledgement.
    // Clear FPB state, disconnect SWD, and close HID before the process exits.
    (void)handleClose(channel);
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
  } else if (name == "readMemoryBatch") {
    result = handleReadMemoryBatch(*params, channel);
  } else if (name == "readMemoryBlock") {
    result = handleReadMemoryBlock(*params, channel);
  } else if (name == "writeMemory") {
    result = handleWriteMemory(*params, channel);
  } else if (name == "startRtt") {
    result = handleStartRtt(*params, channel);
  } else if (name == "stopRtt") {
    result = handleStopRtt(channel);
  } else if (name == "readRtt") {
    result = handleReadRtt(*params, channel);
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
  } else if (name == "runToAddress") {
    result = handleRunToAddress(*params, channel);
  } else if (name == "stepInstruction") {
    result = handleCoreStepInstruction(*params, channel);
  } else if (name == "readRegister") {
    result = handleCoreReadRegister(*params, channel);
  } else if (name == "getFpbInfo") {
    result = handleGetFpbInfo(*params, channel);
  } else if (name == "setBreakpoint") {
    result = handleSetBreakpoint(*params, channel);
  } else if (name == "clearBreakpoint") {
    result = handleClearBreakpoint(*params, channel);
  } else if (name == "clearAllBreakpoints") {
    result = handleClearAllBreakpoints(*params, channel);
  } else if (name == "stepIntoSourceLine") {
    result = handleSourceStep("stepIntoSourceLine", *params, channel);
  } else if (name == "stepOverSourceLine") {
    result = handleSourceStep("stepOverSourceLine", *params, channel);
  } else if (name == "stepOut") {
    result = handleSourceStep("stepOut", *params, channel);
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

class FakeWinUsbIo : public WinUsbIo {
 public:
  Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) override {
    ++enumerateCalls;
    out.clear();
    DeviceDescriptor device;
    device.path = "\\\\?\\usb#vid_1234&pid_5678#WINUSB-1";
    device.vid = "1234";
    device.pid = "5678";
    device.serial = "WINUSB-1";
    device.transport = "winusb";
    device.protocolPacketSize = protocolPacketSize;
    if (!selector.vid.empty() && selector.vid != device.vid) return Result::success();
    out.push_back(device);
    return Result::success();
  }
  HANDLE createEvent() override { return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(0x8100)); }
  HANDLE createFile(const wchar_t*) override { return fileHandle; }
  BOOL initialize(HANDLE, WINUSB_INTERFACE_HANDLE& handle, DWORD& error) override {
    error = initializeError;
    handle = initializeResult ? interfaceHandle : nullptr;
    return initializeResult;
  }
  BOOL queryInterfaceSettings(WINUSB_INTERFACE_HANDLE, USB_INTERFACE_DESCRIPTOR& descriptor,
                              DWORD& error) override {
    error = ERROR_SUCCESS;
    descriptor = USB_INTERFACE_DESCRIPTOR{};
    descriptor.bInterfaceNumber = 2;
    descriptor.bNumEndpoints = 2;
    return TRUE;
  }
  BOOL queryPipe(WINUSB_INTERFACE_HANDLE, UCHAR index, WINUSB_PIPE_INFORMATION& pipe,
                 DWORD& error) override {
    error = ERROR_SUCCESS;
    pipe = WINUSB_PIPE_INFORMATION{};
    pipe.PipeType = UsbdPipeTypeBulk;
    pipe.PipeId = index == 0 ? 0x81 : 0x02;
    pipe.MaximumPacketSize = index == 0 ? 64 : 512;
    return TRUE;
  }
  BOOL writePipe(WINUSB_INTERFACE_HANDLE, UCHAR endpoint, PUCHAR buffer, ULONG length,
                 PULONG transferred, LPOVERLAPPED, DWORD& error) override {
    ++writeCalls;
    lastWriteEndpoint = endpoint;
    lastWrite.assign(buffer, buffer + length);
    *transferred = writeBytes == UINT32_MAX ? length : writeBytes;
    error = writeError;
    return writeResult;
  }
  BOOL readPipe(WINUSB_INTERFACE_HANDLE, UCHAR endpoint, PUCHAR buffer, ULONG capacity,
                PULONG transferred, LPOVERLAPPED, DWORD& error) override {
    ++readCalls;
    lastReadEndpoint = endpoint;
    if (!queuedReads.empty()) {
      readData = queuedReads.front();
      queuedReads.pop_front();
    }
    const ULONG count = static_cast<ULONG>(std::min<size_t>(readData.size(), capacity));
    if (count > 0) std::memcpy(buffer, readData.data(), count);
    *transferred = count;
    error = readError;
    return readResult;
  }
  BOOL abortPipe(WINUSB_INTERFACE_HANDLE, UCHAR endpoint, DWORD& error) override {
    ++abortCalls;
    abortedEndpoint = endpoint;
    error = abortError;
    return abortResult;
  }
  BOOL getOverlappedResult(HANDLE, LPOVERLAPPED, LPDWORD transferred, BOOL,
                           DWORD& error) override {
    ++overlappedCalls;
    *transferred = overlappedBytes;
    error = overlappedError;
    return overlappedResult;
  }
  DWORD waitForSingleObject(HANDLE, DWORD) override { return waitResult; }
  BOOL freeInterface(WINUSB_INTERFACE_HANDLE) override { ++freeCalls; return TRUE; }
  BOOL closeHandle(HANDLE) override { ++closeCalls; return TRUE; }

  HANDLE fileHandle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(0x8000));
  WINUSB_INTERFACE_HANDLE interfaceHandle = reinterpret_cast<WINUSB_INTERFACE_HANDLE>(static_cast<uintptr_t>(0x8001));
  uint16_t protocolPacketSize = 512;
  BOOL initializeResult = TRUE;
  DWORD initializeError = ERROR_SUCCESS;
  BOOL writeResult = TRUE;
  DWORD writeError = ERROR_SUCCESS;
  DWORD writeBytes = UINT32_MAX;
  BOOL readResult = TRUE;
  DWORD readError = ERROR_SUCCESS;
  std::vector<uint8_t> readData;
  std::deque<std::vector<uint8_t>> queuedReads;
  BOOL abortResult = TRUE;
  DWORD abortError = ERROR_SUCCESS;
  BOOL overlappedResult = FALSE;
  DWORD overlappedError = ERROR_OPERATION_ABORTED;
  DWORD overlappedBytes = 0;
  DWORD waitResult = WAIT_OBJECT_0;
  int enumerateCalls = 0;
  int writeCalls = 0;
  int readCalls = 0;
  int abortCalls = 0;
  int overlappedCalls = 0;
  int freeCalls = 0;
  int closeCalls = 0;
  UCHAR lastWriteEndpoint = 0;
  UCHAR lastReadEndpoint = 0;
  UCHAR abortedEndpoint = 0;
  std::vector<uint8_t> lastWrite;
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
  TransportIoCounters ioCounters() const override { return counters; }

  std::vector<uint8_t> lastRequest;
  std::vector<std::vector<uint8_t>> requests;
  std::vector<uint8_t> scripted;
  std::deque<std::vector<uint8_t>> scriptedResponses;
  int writeCalls = 0;
  TransportIoCounters counters;
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

  // --- CMSIS-DAP v2 WinUSB transport through the injected backend. ---
  {
    FakeWinUsbIo io;
    CmsisDapWinUsbTransport transport(&io);
    DeviceSelector selector;
    std::vector<DeviceDescriptor> devices;
    expect(transport.enumerate(selector, devices).ok && devices.size() == 1,
           "winusb-enumerate");
    expect(transport.open(devices.front()).ok && transport.bulkInEndpoint() == 0x81 &&
               transport.bulkOutEndpoint() == 0x02 &&
               transport.bulkInMaxPacketSize() == 64 &&
               transport.bulkOutMaxPacketSize() == 512,
           "winusb-endpoint-discovery");
    expect(transport.payloadCapacity() == 512, "winusb-protocol-packet-size-not-endpoint-size");

    const uint8_t command[] = {0x05, 0x00, 0x01};
    const Result write = transport.writePacket(command, sizeof(command), std::chrono::milliseconds(5));
    expect(write.ok && io.writeCalls == 1 && io.lastWriteEndpoint == 0x02 &&
               io.lastWrite == std::vector<uint8_t>(command, command + sizeof(command)),
           "winusb-bulk-write-exact-packet");
    std::vector<uint8_t> oversized(513, 0);
    expect(transport.writePacket(oversized.data(), oversized.size(),
                                 std::chrono::milliseconds(5)).errorCode == ErrorCodes::kPacketTooLarge &&
               io.writeCalls == 1,
           "winusb-packet-too-large-not-written");

    io.readData = {0x05, 0x01, 0x01, 0x77};
    uint8_t response[512] = {};
    size_t responseLength = 0;
    const Result read = transport.readPacket(response, sizeof(response), responseLength,
                                             std::chrono::milliseconds(5));
    expect(read.ok && responseLength == 4 && response[0] == 0x05 && response[3] == 0x77 &&
               io.lastReadEndpoint == 0x81,
           "winusb-short-read-preserved");

    io.readData = {0x05, 0x01, 0x01, 0x77, 0x14, 0xA0, 0x2B};
    CmsisDapProtocol protocol(&transport);
    std::vector<DapTransferItem> items(1);
    items[0].rnw = true;
    uint8_t completed = 0;
    const Result transfer = protocol.dapTransfer(0, items, std::chrono::milliseconds(5), &completed);
    expect(transfer.ok && completed == 1 && items[0].readData == 0x2BA01477u &&
               io.lastWrite == std::vector<uint8_t>({0x05, 0x00, 0x01, 0x02}),
           "winusb-shares-official-dap-transfer-protocol");
  }
  {
    FakeWinUsbIo io;
    CmsisDapWinUsbTransport transport(&io);
    std::vector<DeviceDescriptor> devices;
    DeviceSelector selector;
    transport.enumerate(selector, devices);
    expect(transport.open(devices.front()).ok, "winusb-timeout-open");
    io.writeResult = FALSE;
    io.writeError = ERROR_IO_PENDING;
    io.waitResult = WAIT_TIMEOUT;
    io.overlappedResult = TRUE;
    io.overlappedError = ERROR_SUCCESS;
    io.overlappedBytes = 2;
    const uint8_t command[] = {0x02, 0x01};
    const Result late = transport.writePacket(command, sizeof(command), std::chrono::milliseconds(1));
    expect(!late.ok && late.errorCode == ErrorCodes::kWriteCompletedLate && io.writeCalls == 1,
           "winusb-late-write-not-resent");

    io.overlappedResult = FALSE;
    io.overlappedError = ERROR_CRC;
    const Result unknown = transport.writePacket(command, sizeof(command), std::chrono::milliseconds(1));
    expect(!unknown.ok && unknown.errorCode == ErrorCodes::kOutcomeUnknown && io.writeCalls == 2,
           "winusb-unknown-write-not-resent");

    io.overlappedError = ERROR_DEVICE_REMOVED;
    const Result removed = transport.writePacket(command, sizeof(command), std::chrono::milliseconds(1));
    expect(!removed.ok && removed.errorCode == ErrorCodes::kDeviceRemoved &&
               transport.deviceLost() && !transport.isOpen(),
           "winusb-device-removal-closes-owner");
    const int writesAfterRemoval = io.writeCalls;
    expect(transport.writePacket(command, sizeof(command), std::chrono::milliseconds(1)).errorCode ==
               ErrorCodes::kDeviceRemoved && io.writeCalls == writesAfterRemoval,
           "winusb-no-io-after-removal");
  }
  {
    FakeWinUsbIo io;
    CmsisDapWinUsbTransport transport(&io);
    std::vector<DeviceDescriptor> devices;
    DeviceSelector selector;
    transport.enumerate(selector, devices);
    expect(transport.open(devices.front()).ok, "winusb-drain-open");
    io.queuedReads = {{0x00, 0x01}, {0x05, 0x00}, {}};
    expect(transport.drainInput(std::chrono::milliseconds(1)).ok && io.readCalls == 3,
           "winusb-stale-input-drain");
    io.readData.assign(513, 0xAA);
    uint8_t small[4] = {};
    size_t length = 0;
    expect(transport.readPacket(small, sizeof(small), length, std::chrono::milliseconds(1)).errorCode ==
               ErrorCodes::kMalformedResponse,
           "winusb-malformed-response-capacity");
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
    // DAP-07 independent packed-read oracle. Three scattered words must fit
    // in one 64-byte DAP_Transfer, remain in caller order, and contain no AP
    // DRW write request (0x0D).
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap07-scattered-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const std::vector<uint32_t> addresses = {0x20000008u, 0x20000000u, 0x20000020u};
    const Result result = target.readMemoryScattered32(
        addresses, values, completedReads, diag, std::chrono::milliseconds(200));
    expect(result.ok && completedReads == 3 && values == std::vector<uint32_t>({
               mockWordAt(0x20000008u), mockWordAt(0x20000000u), mockWordAt(0x20000020u)}),
           "dap07-scattered-values-preserve-order");
    expect(diag.packets == 1 && diag.packedReads == 3 && diag.fallbackReads == 0,
           "dap07-scattered-one-packet-diagnostics");
    const std::vector<uint8_t> expectedRequest = {
        0x05, 0x00, 0x0B,
        0x08, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x12, 0x00, 0x00, 0xA2,
        0x05, 0x08, 0x00, 0x00, 0x20, 0x0F, 0x0E,
        0x05, 0x00, 0x00, 0x00, 0x20, 0x0F, 0x0E,
        0x05, 0x20, 0x00, 0x00, 0x20, 0x0F, 0x0E,
    };
    expect(mock.lastTransferRequest() == expectedRequest,
           "dap07-scattered-hardcoded-request-frame-no-target-write");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap07-capacity-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> addresses;
    for (uint32_t i = 0; i < 8; ++i) addresses.push_back(0x20000000u + i * 0x20u);
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const Result result = target.readMemoryScattered32(
        addresses, values, completedReads, diag, std::chrono::milliseconds(200));
    expect(result.ok && completedReads == 8 && values.size() == 8 && diag.packets == 2 &&
               diag.packedReads == 8 && mock.injection().transferCount == 2,
           "dap07-scattered-64-byte-capacity-splits-7-plus-1");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap07-unaligned-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const Result result = target.readMemoryScattered32(
        {0x20000001u}, values, completedReads, diag, std::chrono::milliseconds(200));
    expect(!result.ok && result.errorCode == ErrorCodes::kDapInvalidRequest &&
               completedReads == 0 && diag.packets == 0,
           "dap07-scattered-unaligned-rejected-before-io");
  }

  {
    // Literal response frame: five transfers completed (one whole scalar),
    // then WAIT. Repeating it through the bounded retry budget must report
    // exactly one completed read and never mark later reads successful.
    ScriptedTransport scripted;
    for (uint32_t attempt = 0; attempt <= kMaxTransferRetries; ++attempt) {
      scripted.scriptedResponses.push_back(
          {0x05, 0x05, 0x02, 0xAA, 0xAA, 0xAA, 0xAA, 0x44, 0x33, 0x22, 0x11});
    }
    CmsisDapProtocol protocol(&scripted);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const Result result = target.readMemoryScattered32(
        {0x20000000u, 0x20000020u}, values, completedReads, diag,
        std::chrono::milliseconds(200));
    expect(!result.ok && result.errorCode == ErrorCodes::kDapAckWait &&
               completedReads == 1 && values == std::vector<uint32_t>({0x11223344u}) &&
               diag.waitRetries == kMaxTransferRetries,
           "dap07-scattered-partial-completion-exact");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5680", mock), "dap07-fault-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const Result result = target.readMemoryScattered32(
        {0x20000000u, 0x20000020u}, values, completedReads, diag,
        std::chrono::milliseconds(200));
    expect(result.ok && completedReads == 2 && values.size() == 2 && diag.faultClears >= 1,
           "dap07-scattered-fault-clears-and-recovers");
  }

  {
    ScriptedTransport scripted;
    scripted.scripted = {0x05, 0x05, 0x01, 0xAA};
    CmsisDapProtocol protocol(&scripted);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const Result result = target.readMemoryScattered32(
        {0x20000000u}, values, completedReads, diag, std::chrono::milliseconds(200));
    expect(!result.ok && result.errorCode == ErrorCodes::kMalformedResponse &&
               completedReads == 0 && values.empty(),
           "dap07-scattered-short-response-rejected");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5685", mock), "dap07-removal-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    uint32_t completedReads = 0;
    const Result result = target.readMemoryScattered32(
        {0x20000000u}, values, completedReads, diag, std::chrono::milliseconds(200));
    expect(!result.ok && result.errorCode == ErrorCodes::kDeviceRemoved &&
               completedReads == 0 && values.empty() && mock.deviceLost(),
           "dap07-scattered-device-removal-is-terminal");
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

    const std::vector<uint8_t> writeBytes = {0x11, 0x22, 0x33, 0x44, 0x55};
    diag = DapTransferDiagnostics{};
    const Result writeUnaligned = target.writeMemory(0x20000201, writeBytes, diag);
    expect(writeUnaligned.ok, "dap06-byte-write-unaligned");
    std::vector<uint8_t> readBack;
    diag = DapTransferDiagnostics{};
    const Result readWritten = target.readMemory(0x20000201, 5, readBack, diag);
    expect(readWritten.ok && readBack == writeBytes, "dap06-byte-write-readback");
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
    expect(step.interruptMaskApplied && step.interruptMaskCleared &&
               (step.dhcsr & kCoreDebugCMaskInts) != 0,
           "dap04-step-masks-interrupts-during-c-step");
    expect(mock.targetState().lastDhcsrWrite ==
               (kCoreDebugDbgKey | kCoreDebugCDebugEn | kCoreDebugCHalt),
           "dap04-step-clears-interrupt-mask-while-halted");

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
    const Result invalidRegister = debug.readRegister(21, value, diag, timeout);
    expect(!invalidRegister.ok && invalidRegister.errorCode == ErrorCodes::kDapInvalidRequest,
           "dap04-invalid-register");

    expect(debug.reset(state, diag, timeout).ok && state.halted && state.pc == kMockResetPc,
           "dap04-reset-confirmed");
    expect(mock.targetState().lastAircrWrite ==
               (kCoreDebugVectKey | kCoreDebugSysResetReq),
           "dap04-reset-key-and-bit");
  }

  {
    // A halted state read already owns a valid DHCSR sample. Resolving the PC
    // must reuse that sample instead of issuing a second DHCSR read.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap05-state-cache-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics setupDiag;
    CortexMDebugState setupState;
    expect(debug.halt(setupState, setupDiag, std::chrono::milliseconds(100)).ok,
           "dap05-state-cache-halt");
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    const Result result = debug.getState(state, diag, std::chrono::milliseconds(100));
    expect(result.ok && state.halted && state.pcValid && diag.packets == 4,
           "dap05-state-cache-reuses-dhcsr");
  }

  {
    // Repeated control RPCs on one connected owner must not repeat the full
    // DP power-up sequence. Explicit resource reset invalidates the cache.
    Channel channel;
    auto mockTransport = std::make_unique<MockCmsisDapTransport>();
    MockCmsisDapTransport* mock = mockTransport.get();
    channel.transport = std::move(mockTransport);
    DeviceSelector selector;
    std::vector<DeviceDescriptor> devices;
    expect(channel.transport->enumerate(selector, devices).ok && !devices.empty() &&
               channel.transport->open(devices.front()).ok,
           "dap05-debug-power-cache-open");
    channel.opened = true;
    channel.connected = true;
    channel.packetSize = 64;
    CmsisDapProtocol protocol(channel.transport.get());
    protocol.setEffectivePacketSize(channel.packetSize);
    CmsisDapTarget target(&protocol, channel.packetSize);
    DapTransferDiagnostics firstDiag;
    const Result first = ensureDebugPower(channel, target, firstDiag,
                                          std::chrono::milliseconds(100));
    const size_t afterFirst = mock->commandHistory().size();
    DapTransferDiagnostics secondDiag;
    const Result second = ensureDebugPower(channel, target, secondDiag,
                                           std::chrono::milliseconds(100));
    const size_t afterSecond = mock->commandHistory().size();
    expect(first.ok && second.ok && afterFirst > 0 && afterSecond == afterFirst,
           "dap05-debug-power-cache-hit");
    channel.clearDebugResourceState();
    DapTransferDiagnostics thirdDiag;
    const Result third = ensureDebugPower(channel, target, thirdDiag,
                                          std::chrono::milliseconds(100));
    expect(third.ok && mock->commandHistory().size() > afterSecond,
           "dap05-debug-power-cache-invalidated");
  }

  {
    // Source-step owns the target for its complete control critical section
    // and already has the current halted PC. The specialized step path still
    // verifies S_HALT, but must not fetch the same PC a second time.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap05-known-pc-step-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics setupDiag;
    CortexMDebugState halted;
    expect(debug.halt(halted, setupDiag, std::chrono::milliseconds(100)).ok &&
               halted.halted && halted.pcValid,
           "dap05-known-pc-step-halt");
    DapTransferDiagnostics diag;
    CortexMDebugStepResult step;
    const Result result = debug.stepInstructionFromHaltedPc(
        halted.pc, step, diag, std::chrono::milliseconds(100));
    expect(result.ok && step.pcBefore == halted.pc && step.pcAfter != step.pcBefore &&
               step.instructionRetired && step.interruptMaskCleared && diag.packets == 9,
           "dap05-known-pc-step-skips-duplicate-pc-read");
  }

  {
    // STM32H723 / Cortex-M7 C_STEP can re-halt with a new PC without latching
    // S_RETIRE_ST. Instruction step must still succeed from the observed PC.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5690", mock), "dap11-h723-step-omit-retire-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics setupDiag;
    CortexMDebugState halted;
    expect(debug.halt(halted, setupDiag, std::chrono::milliseconds(100)).ok &&
               halted.halted && halted.pcValid,
           "dap11-h723-step-omit-retire-halt");
    DapTransferDiagnostics diag;
    CortexMDebugStepResult step;
    const Result result = debug.stepInstruction(step, diag, std::chrono::milliseconds(100));
    expect(result.ok && step.halted && step.pcAfter != step.pcBefore &&
               !step.instructionRetired && step.interruptMaskCleared,
           "dap11-h723-step-succeeds-without-s-retire-st");
  }

  {
    // Step-out needs PC/LR/SP from one stopped state. Read the initial DHCSR
    // once, then perform the architecturally required DCRSR/DCRDR sequence for
    // each register without repeating the halted-state query.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap05-register-batch-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics setupDiag;
    CortexMDebugState halted;
    expect(debug.halt(halted, setupDiag, std::chrono::milliseconds(100)).ok,
           "dap05-register-batch-halt");
    DapTransferDiagnostics diag;
    std::vector<uint32_t> values;
    const Result result = debug.readRegisters(
        {15u, 14u, 13u}, values, diag, std::chrono::milliseconds(100));
    expect(result.ok && values == std::vector<uint32_t>({halted.pc, 0x08001001u,
                                                         0x20001000u}) &&
               diag.packets == 10,
           "dap05-register-batch-one-halt-check");
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
    // A configurable interrupt can be pending when the helper rewrites the
    // halted core registers for a RAM Flash Algorithm. The launch primitive
    // must mask it before resume, rather than relying on the algorithm's first
    // instruction to execute CPSID I before the interrupt is taken.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "568E", mock), "dap02a-algorithm-interrupt-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    CortexMDebugState state;
    expect(debug.halt(state, diag, std::chrono::milliseconds(100)).ok && state.halted,
           "dap02a-algorithm-interrupt-halted-precondition");
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
    request.r0 = request.targetAddress;
    request.r1 = 4000000u;
    mock.prepareFlashAlgorithm("init", request.targetAddress, 0, noData,
                               request.bkptAddress);
    FlashAlgorithmRunResult algorithmResult;
    const Result algorithm = debug.executeFlashAlgorithm(
        request, algorithmResult, diag, std::chrono::milliseconds(20));
    expect(algorithm.ok && algorithmResult.returnCode == 0,
           "dap02a-algorithm-interrupt-window-masked");
    expect(mock.injection().algorithmInterruptMaskAtEntry,
           "dap02a-algorithm-interrupt-mask-present-at-entry");
    expect((mock.targetState().lastDhcsrWrite & kMockCoreDebugCMaskInts) == 0 &&
               (mock.targetState().lastDhcsrWrite & kMockCoreDebugCHalt) != 0,
           "dap02a-algorithm-interrupt-mask-cleared-after-halt");
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

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap05-exc-return-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    expect(target.initializeDebugPower(diag, std::chrono::milliseconds(100)).ok,
           "dap05-exc-return-debug-power");
    mock.prepareExceptionReturn(0x080001E0u, 0xFFFFFFF9u,
                                0x20001000u, 0x080001F1u);
    FpbState fpbState;
    CmsisDapSourceStepper stepper(&target, &debug, &fpbState);
    SourceStepResult step;
    const Result result = stepper.stepOut(0x080001E0u, 0x080001E4u, step, diag,
                                          std::chrono::milliseconds(100));
    expect(result.ok && step.classification == "exceptionReturnBreakpoint" &&
               step.lr == 0xFFFFFFF9u && step.returnAddress == 0x080001F0u &&
               step.pcAfter == 0x080001F0u && step.cleanupOk,
           "dap05-step-out-exc-return-basic-msp");
  }

  {
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap05-wide-branch-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    expect(target.initializeDebugPower(diag, std::chrono::milliseconds(100)).ok,
           "dap05-wide-branch-debug-power");
    mock.prepareSourceInstruction(0x080001C0u, {0x00, 0xF0, 0x00, 0x80});
    FpbState fpbState;
    CmsisDapSourceStepper stepper(&target, &debug, &fpbState);
    SourceStepResult step;
    const Result result = stepper.stepInto(0x080001C0u, 0x080001C2u, 1u, step, diag,
                                           std::chrono::milliseconds(100));
    expect(result.ok && step.classification == "branch" && !step.enteredCall &&
               step.trace.size() == 1 && !step.trace.front().call,
           "dap05-wide-conditional-branch-is-not-call");
  }

  {
    // A call return breakpoint that never fires (1234:568C FPB never hits)
    // must time out with StepTimeout, halt the target, and report the
    // recovered halt PC so the client can move the UI to the real stop
    // location instead of leaving the cursor on the timed-out line.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "568C", mock), "dap05-step-timeout-recovery-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    expect(target.initializeDebugPower(diag, std::chrono::milliseconds(100)).ok,
           "dap05-step-timeout-recovery-debug-power");
    mock.prepareSourceInstruction(0x080001C2u, {0x00, 0xF0, 0x0D, 0xF8});
    FpbState fpbState;
    CmsisDapSourceStepper stepper(&target, &debug, &fpbState);
    SourceStepResult step;
    const Result result = stepper.stepOver(0x080001C2u, 0x080001C6u, 4u, step, diag,
                                           std::chrono::milliseconds(50));
    expect(!result.ok && result.errorCode == "StepTimeout" &&
               step.stopReason == "RecoveryHalt" &&
               step.classification == "recoveredHalt" && step.cleanupOk,
           "dap05-step-timeout-recovers-halt-and-pc");
  }

  {
    // A helper can be terminated after programming FPB but before its normal
    // cleanup runs. The next owner must not trust its empty in-memory slot map:
    // it claims the hardware by clearing every target-reported comparator.
    MockCmsisDapTransport mock;
    expect(openMock("1234", "5678", mock), "dap05-stale-fpb-open");
    CmsisDapProtocol protocol(&mock);
    CmsisDapTarget target(&protocol, 64);
    CortexMDebug debug(&target);
    DapTransferDiagnostics diag;
    FpbState lostOwnerState;
    FpbBreakpointManager lostOwner(&target, &lostOwnerState);
    FpbCapabilities goldenCapabilities;
    const Result goldenProbe = lostOwner.initialize(goldenCapabilities, diag,
                                                    std::chrono::milliseconds(100));
    expect(goldenProbe.ok && goldenCapabilities.fpCtrl == 0x00000260u &&
               goldenCapabilities.revision == 1u &&
               goldenCapabilities.codeComparators == 6u &&
               goldenCapabilities.literalComparators == 2u &&
               !goldenCapabilities.enabled,
           "dap05-fp-ctrl-0x260-hard-coded-golden");
    FpbBreakpointResult staleBreakpoint;
    const auto timeout = std::chrono::milliseconds(100);
    const Result staleSet = lostOwner.setUser(kMockResetPc, 0u, staleBreakpoint,
                                              diag, timeout);
    expect(staleSet.ok && (mock.targetState().fpCtrl & 1u) != 0 &&
               mock.targetState().fpComp[0] != 0,
           "dap05-stale-fpb-precondition");

    lostOwnerState.reset();
    FpbState newOwnerState;
    CortexMDebugState finalState;
    const Result claim = claimFpbOwnership(target, debug, newOwnerState,
                                           finalState, diag, timeout);
    const bool comparatorsCleared = std::all_of(
        mock.targetState().fpComp.begin(), mock.targetState().fpComp.end(),
        [](uint32_t value) { return value == 0; });
    expect(claim.ok && newOwnerState.initialized && comparatorsCleared &&
               (mock.targetState().fpCtrl & 1u) == 0 && !finalState.halted,
           "dap05-new-owner-clears-stale-fpb-and-restores-running");
  }

  std::cout << "{\"selftest\":\"" << (failures == 0 ? "ok" : "fail")
            << "\",\"cases\":" << 200 << ",\"failures\":" << failures << "}\n"
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
  if (channel.requestedTransport.empty()) channel.requestedTransport = "auto";
  diag("starting helper version=" + std::string(kHelperVersion) + " protocol=" +
       std::to_string(kProtocolVersion) + " defaultTransport=" + channel.requestedTransport);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::string response;
    bool shutdownRequested = false;
    try {
      const JsonValue request = JsonParser(line).parse();
      const JsonValue* method = request.get("method");
      shutdownRequested = method && method->kind == JsonValue::Kind::String &&
                          method->string == "shutdown";
      response = dispatch(request, channel);
    } catch (const std::exception& error) {
      response = protocolError(line, error.what());
    }
    std::cout << response << '\n' << std::flush;
    if (shutdownRequested) break;
  }
  // Parent loss closes stdin without a shutdown request. Best-effort cleanup
  // still restores/removes FPB resources before releasing the HID handle.
  if (channel.opened || channel.transport) (void)handleClose(channel);
  diag("stdin closed, exiting");
  return 0;
}

}  // namespace cmsis_dap_helper

int main(int argc, char** argv) {
  return cmsis_dap_helper::run(argc, argv);
}
