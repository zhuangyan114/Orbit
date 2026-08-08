#include "cmsis_dap_hid_transport.h"

#include <hidsdi.h>
#include <setupapi.h>

#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <sstream>

#include "trace_control.h"

namespace cmsis_dap_helper {

namespace {

std::string hidHexDump(const std::vector<uint8_t>& bytes) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(bytes.size() * 3);
  for (size_t i = 0; i < bytes.size(); ++i) {
    if (i != 0) out += ' ';
    out += kHex[(bytes[i] >> 4) & 0x0F];
    out += kHex[bytes[i] & 0x0F];
  }
  return out;
}

void hidTrace(const std::string& message) {
  if (!rawTraceEnabled()) return;
  std::cerr << "[cmsis-dap-hid] " << message << std::endl;
}

std::string wstringToUtf8(const std::wstring& input) {
  if (input.empty()) return "";
  const int size = WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()),
                                       nullptr, 0, nullptr, nullptr);
  if (size <= 0) return "";
  std::string output(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()), output.data(),
                      size, nullptr, nullptr);
  return output;
}

std::string formatId(uint16_t id) {
  char buffer[5];
  std::snprintf(buffer, sizeof(buffer), "%04X", id);
  return std::string(buffer);
}

std::string lastErrorMessage(DWORD error) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  std::wstring message = length > 0 && buffer ? std::wstring(buffer, length) : L"";
  if (buffer) LocalFree(buffer);
  while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) {
    message.pop_back();
  }
  return wstringToUtf8(message);
}

bool isDeviceGoneError(DWORD error) {
  switch (error) {
    case ERROR_DEVICE_REMOVED:
    case ERROR_DEVICE_NOT_CONNECTED:
    case ERROR_NO_SUCH_DEVICE:
    case ERROR_ACCESS_DENIED:
    case ERROR_GEN_FAILURE:
    case ERROR_OPERATION_ABORTED:
    case ERROR_NOT_READY:
    case ERROR_FILE_NOT_FOUND:
    case ERROR_INVALID_HANDLE:
      return true;
    default:
      return false;
  }
}

struct HandleGuard {
  HANDLE handle;
  ~HandleGuard() {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};

struct DevInfoGuard {
  HDEVINFO info;
  ~DevInfoGuard() {
    if (info != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(info);
  }
};

}  // namespace

HANDLE RealHidIo::createEvent() {
  return CreateEventW(nullptr, TRUE, FALSE, nullptr);
}

BOOL RealHidIo::cancelIoEx(HANDLE file, OVERLAPPED* overlapped, DWORD& lastError) {
  const BOOL ok = CancelIoEx(file, overlapped);
  lastError = GetLastError();
  return ok;
}

BOOL RealHidIo::getOverlappedResult(HANDLE file, OVERLAPPED* overlapped, DWORD& bytesTransferred,
                                    BOOL wait, DWORD& lastError) {
  const BOOL ok = GetOverlappedResult(file, overlapped, &bytesTransferred, wait);
  lastError = GetLastError();
  return ok;
}

BOOL RealHidIo::readFile(HANDLE file, void* buffer, DWORD bytesToRead, OVERLAPPED* overlapped,
                         DWORD& lastError) {
  DWORD bytesRead = 0;
  const BOOL ok = ::ReadFile(file, buffer, bytesToRead, &bytesRead, overlapped);
  lastError = GetLastError();
  return ok;
}

BOOL RealHidIo::writeFile(HANDLE file, const void* buffer, DWORD bytesToWrite,
                          OVERLAPPED* overlapped, DWORD& lastError) {
  DWORD bytesWritten = 0;
  const BOOL ok = ::WriteFile(file, buffer, bytesToWrite, &bytesWritten, overlapped);
  lastError = GetLastError();
  return ok;
}

BOOL RealHidIo::closeHandle(HANDLE object) {
  return CloseHandle(object);
}

DWORD RealHidIo::waitForSingleObject(HANDLE object, DWORD timeoutMs) {
  return WaitForSingleObject(object, timeoutMs);
}

HANDLE RealHidIo::createFile(const wchar_t* path) {
  return CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
}

BOOL RealHidIo::setOutputReport(HANDLE file, const void* buffer, DWORD bytes) {
  // HidD_SetOutputReport takes PVOID but does not modify the report buffer.
  return HidD_SetOutputReport(file, const_cast<void*>(buffer), bytes);
}

CmsisDapHidTransport::CmsisDapHidTransport() : io_(realIo_.get()) {}
CmsisDapHidTransport::CmsisDapHidTransport(HidIo* io) : io_(io ? io : realIo_.get()) {}

CmsisDapHidTransport::~CmsisDapHidTransport() {
  if (handle_ != INVALID_HANDLE_VALUE) {
    io_->closeHandle(handle_);
    handle_ = INVALID_HANDLE_VALUE;
  }
}

Result CmsisDapHidTransport::enumerate(const DeviceSelector& selector,
                                       std::vector<DeviceDescriptor>& out) {
  out.clear();
  GUID hidGuid;
  HidD_GetHidGuid(&hidGuid);
  HDEVINFO deviceInfo = SetupDiGetClassDevsW(&hidGuid, nullptr, nullptr,
                                             DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (deviceInfo == INVALID_HANDLE_VALUE) {
    return Result::error(ErrorCodes::kInternalError,
                         "SetupDiGetClassDevs failed: " + lastErrorMessage(GetLastError()));
  }
  std::unique_ptr<DevInfoGuard> deviceInfoGuard(new DevInfoGuard{deviceInfo});

  for (DWORD index = 0;; ++index) {
    SP_DEVICE_INTERFACE_DATA interfaceData{};
    interfaceData.cbSize = sizeof(interfaceData);
    if (!SetupDiEnumDeviceInterfaces(deviceInfo, nullptr, &hidGuid, index, &interfaceData)) {
      const DWORD error = GetLastError();
      if (error == ERROR_NO_MORE_ITEMS) break;
      continue;
    }
    DWORD required = 0;
    SetupDiGetDeviceInterfaceDetailW(deviceInfo, &interfaceData, nullptr, 0, &required, nullptr);
    if (required == 0) continue;
    std::vector<uint8_t> buffer(required);
    auto* detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(buffer.data());
    detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
    if (!SetupDiGetDeviceInterfaceDetailW(deviceInfo, &interfaceData, detail, required, nullptr,
                                          nullptr)) {
      continue;
    }
    const std::wstring devicePath = detail->DevicePath;

    // Query-only open to read attributes, strings and report capabilities.
    HANDLE query = CreateFileW(devicePath.c_str(), GENERIC_READ | GENERIC_WRITE,
                               FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0,
                               nullptr);
    if (query == INVALID_HANDLE_VALUE) continue;
    HandleGuard queryGuard{query};

    HIDD_ATTRIBUTES attributes{};
    attributes.Size = sizeof(attributes);
    if (!HidD_GetAttributes(query, &attributes)) continue;

    DeviceDescriptor device;
    device.path = wstringToUtf8(devicePath);
    device.vid = formatId(attributes.VendorID);
    device.pid = formatId(attributes.ProductID);
    device.transport = "hid";

    wchar_t stringBuffer[256] = {};
    if (HidD_GetManufacturerString(query, stringBuffer, sizeof(stringBuffer))) {
      device.manufacturer = wstringToUtf8(stringBuffer);
    }
    if (HidD_GetProductString(query, stringBuffer, sizeof(stringBuffer))) {
      device.product = wstringToUtf8(stringBuffer);
    }
    if (HidD_GetSerialNumberString(query, stringBuffer, sizeof(stringBuffer))) {
      device.serial = wstringToUtf8(stringBuffer);
    }

    PHIDP_PREPARSED_DATA preparsed = nullptr;
    if (HidD_GetPreparsedData(query, &preparsed)) {
      HIDP_CAPS caps{};
      if (HidP_GetCaps(preparsed, &caps) == HIDP_STATUS_SUCCESS) {
        device.inputReportLength = static_cast<uint16_t>(caps.InputReportByteLength);
        device.outputReportLength = static_cast<uint16_t>(caps.OutputReportByteLength);
        device.usagePage = caps.UsagePage;
        device.usage = caps.Usage;
        if (caps.NumberInputValueCaps > 0) {
          std::vector<HIDP_VALUE_CAPS> valueCaps(caps.NumberInputValueCaps);
          USHORT numCaps = static_cast<USHORT>(caps.NumberInputValueCaps);
          if (HidP_GetValueCaps(HidP_Input, valueCaps.data(), &numCaps, preparsed) ==
              HIDP_STATUS_SUCCESS) {
            device.reportId = static_cast<uint8_t>(valueCaps[0].ReportID);
          }
        }
      }
      HidD_FreePreparsedData(preparsed);
    }

    // Apply filters: exact path wins; otherwise VID/PID (case-insensitive hex)
    // plus optional serial/product exact matches.
    if (!selector.path.empty()) {
      if (selector.path != device.path) continue;
    } else {
      if (!selector.vid.empty() && selector.vid != device.vid) continue;
      if (!selector.pid.empty() && selector.pid != device.pid) continue;
      if (!selector.serial.empty() && selector.serial != device.serial) continue;
      if (!selector.product.empty() && selector.product != device.product) continue;
    }
    out.push_back(std::move(device));
  }
  return Result::success();
}

Result CmsisDapHidTransport::open(const DeviceDescriptor& device) {
  if (isOpen()) {
    return Result::error(ErrorCodes::kInvalidState, "HID device is already open");
  }
  if (device.path.empty()) {
    return Result::error(ErrorCodes::kDeviceNotFound, "HID device path is empty");
  }
  const int wideLength = MultiByteToWideChar(CP_UTF8, 0, device.path.c_str(), -1, nullptr, 0);
  if (wideLength <= 0) {
    return Result::error(ErrorCodes::kDeviceOpenFailed, "device path is not valid UTF-8");
  }
  std::wstring widePath(static_cast<size_t>(wideLength), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, device.path.c_str(), -1, widePath.data(), wideLength);

  HANDLE handle = io_->createFile(widePath.c_str());
  if (handle == INVALID_HANDLE_VALUE) {
    return Result::error(ErrorCodes::kDeviceOpenFailed,
                         "CreateFile failed: " + lastErrorMessage(GetLastError()));
  }
  handle_ = handle;
  path_ = device.path;
  reportId_ = device.reportId;
  inputReportLength_ = device.inputReportLength;
  outputReportLength_ = device.outputReportLength;
  payloadCapacity_ = device.outputReportLength > 1
                         ? static_cast<size_t>(device.outputReportLength) - 1
                         : 0;
  lost_ = false;
  transportMode_ = WriteTransportMode::InterruptOut;  // per-open session mode
  ioCounters_ = TransportIoCounters{};
  return Result::success();
}

Result CmsisDapHidTransport::close() {
  if (handle_ != INVALID_HANDLE_VALUE) {
    io_->closeHandle(handle_);  // cancels pending overlapped I/O on this handle
    handle_ = INVALID_HANDLE_VALUE;
  }
  lost_ = false;
  transportMode_ = WriteTransportMode::InterruptOut;  // reset per-open session mode
  return Result::success();
}

Result CmsisDapHidTransport::writePacket(const uint8_t* data, size_t length,
                                         std::chrono::milliseconds timeout) {
  if (lost_) {
    // A device-loss error previously settled: the handle is closed. Fail fast
    // with DeviceRemoved instead of attempting any further HID I/O.
    return Result::error(ErrorCodes::kDeviceRemoved, "HID device was removed");
  }
  if (!isOpen()) {
    return Result::error(ErrorCodes::kInvalidState, "HID device is not open");
  }
  if (length > payloadCapacity_) {
    return Result::error(ErrorCodes::kPacketTooLarge,
                         "command packet of " + std::to_string(length) +
                             " bytes exceeds HID payload capacity of " +
                             std::to_string(payloadCapacity_) + " bytes");
  }
  std::vector<uint8_t> report(outputReportLength_, 0);
  report[0] = reportId_;
  if (length > 0) std::memcpy(report.data() + 1, data, length);
  hidTrace("write mode=" +
           std::string(transportMode_ == WriteTransportMode::InterruptOut ? "interrupt-out" :
                                                                            "control") +
           " reportId=" + std::to_string(reportId_) +
           " reportLength=" + std::to_string(report.size()) +
           " payloadLength=" + std::to_string(length) +
           " report=" + hidHexDump(report));
  if (transportMode_ == WriteTransportMode::InterruptOut) {
    ++ioCounters_.writeReports;
    ioCounters_.writePayloadBytes += length;
    ioCounters_.writeReportBytes += report.size();
    const Result result = overlappedWrite(report, timeout);
    if (result.ok) {
      hidTrace("write result=ok mode=interrupt-out");
      return result;
    }
    hidTrace("write result=error mode=interrupt-out code=" + result.errorCode +
             " message=" + result.message);
    // A device-loss settle error marks the transport lost and closes the
    // handle; the original error is DeviceRemoved, never resent.
    if (result.errorCode == ErrorCodes::kDeviceRemoved) return result;
    if (result.errorCode == ErrorCodes::kWriteTimeout) {
      // The write timed out and cancellation was CONFIRMED via
      // GetOverlappedResult (ERROR_OPERATION_ABORTED): the command is provably
      // not in flight and was not sent, so a control-transfer resend is safe.
      // Switch this open session to control-transfer output.
      transportMode_ = WriteTransportMode::ControlTransfer;
    } else {
      // CompletedLate / Unknown / any other failure: the original command may
      // have been sent; never resend it through another path.
      return result;
    }
  }
  // Control-transfer output report path (HidD_SetOutputReport), verified
  // working against CMSIS-DAP_LU during DAP-00. On failure keep the more
  // specific original error when the device is still present.
  if (lost_) {
    return Result::error(ErrorCodes::kDeviceRemoved, "HID device was removed");
  }
  ++ioCounters_.writeReports;
  ioCounters_.writePayloadBytes += length;
  ioCounters_.writeReportBytes += report.size();
  if (io_->setOutputReport(handle_, report.data(), static_cast<DWORD>(report.size()))) {
    hidTrace("write result=ok mode=control");
    return Result::success();
  }
  const DWORD fallbackError = GetLastError();
  hidTrace("write result=error mode=control win32=" + std::to_string(fallbackError));
  if (isDeviceGoneError(fallbackError)) {
    return markLost(Result::error(ErrorCodes::kDeviceRemoved,
                                  "HID output report failed: " + lastErrorMessage(fallbackError)));
  }
  return Result::error(ErrorCodes::kWriteTimeout,
                       "HID output report was not accepted (last error " +
                           std::to_string(fallbackError) + ")");
}

Result CmsisDapHidTransport::readPacket(uint8_t* data, size_t capacity, size_t& length,
                                        std::chrono::milliseconds timeout) {
  length = 0;
  if (lost_) {
    // A device-loss error previously settled: the handle is closed. Fail fast
    // with DeviceRemoved instead of attempting any further HID I/O.
    return Result::error(ErrorCodes::kDeviceRemoved, "HID device was removed");
  }
  if (!isOpen()) {
    return Result::error(ErrorCodes::kInvalidState, "HID device is not open");
  }
  std::vector<uint8_t> report(inputReportLength_, 0);
  size_t bytesRead = 0;
  ++ioCounters_.readReports;
  const Result readResult = overlappedRead(report, bytesRead, timeout);
  if (!readResult.ok) {
    hidTrace("read result=error code=" + readResult.errorCode + " message=" + readResult.message);
    return readResult;
  }
  hidTrace("read result=ok reportId=" + std::to_string(report[0]) +
           " bytes=" + std::to_string(bytesRead) + " report=" + hidHexDump(report));
  if (bytesRead < 1) {
    return Result::error(ErrorCodes::kMalformedResponse, "HID read returned an empty report");
  }
  const size_t payload = bytesRead - 1;  // strip the report id byte
  if (payload > capacity) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "HID response payload of " + std::to_string(payload) +
                             " bytes exceeds caller capacity of " + std::to_string(capacity));
  }
  if (payload > 0) std::memcpy(data, report.data() + 1, payload);
  ioCounters_.readPayloadBytes += payload;
  ioCounters_.readReportBytes += bytesRead;
  length = payload;
  return Result::success();
}

Result CmsisDapHidTransport::drainInput(std::chrono::milliseconds timeout) {
  if (!isOpen() || lost_) return Result::success();
  std::vector<uint8_t> report(inputReportLength_, 0);
  size_t bytesRead = 0;
  for (int attempts = 0; attempts < 8; ++attempts) {
    const Result result = overlappedRead(report, bytesRead, timeout);
    if (!result.ok) break;  // read timeout or device gone: nothing more to drain
  }
  return Result::success();
}

Result CmsisDapHidTransport::overlappedWrite(const std::vector<uint8_t>& report,
                                             std::chrono::milliseconds timeout) {
  OVERLAPPED overlapped{};
  overlapped.hEvent = io_->createEvent();
  if (!overlapped.hEvent) {
    return Result::error(ErrorCodes::kInternalError, "CreateEvent failed");
  }
  DWORD lastError = 0;
  const BOOL started = io_->writeFile(handle_, report.data(),
                                      static_cast<DWORD>(report.size()), &overlapped, lastError);
  if (!started && lastError != ERROR_IO_PENDING) {
    io_->closeHandle(overlapped.hEvent);
    return markLost(Result::error(
        isDeviceGoneError(lastError) ? ErrorCodes::kDeviceRemoved : ErrorCodes::kInternalError,
        "HID write failed: " + lastErrorMessage(lastError)));
  }
  const DWORD wait = io_->waitForSingleObject(overlapped.hEvent,
                                              static_cast<DWORD>(timeout.count()));
  if (wait == WAIT_TIMEOUT) {
    // The wait timed out. Settle the operation while the OVERLAPPED and the
    // caller's report buffer stay alive: only a confirmed cancellation
    // (ERROR_OPERATION_ABORTED) allows a control-transfer resend; a completed
    // write means the command was already sent and must never be resent; a
    // device-loss settle error marks the transport lost and closes the handle.
    DWORD bytesIgnored = 0;
    const WriteOutcome outcome = settleOverlapped(overlapped, bytesIgnored);
    io_->closeHandle(overlapped.hEvent);
    switch (outcome) {
      case WriteOutcome::Cancelled:
        return Result::error(ErrorCodes::kWriteTimeout,
                             "HID write timed out and cancellation was confirmed "
                             "(ERROR_OPERATION_ABORTED); resend is safe");
      case WriteOutcome::CompletedLate:
        return Result::error(ErrorCodes::kWriteCompletedLate,
                             "HID write completed after the timeout; the command was "
                             "sent and was NOT resent");
      default:
        // Unknown outcome. If the settle reported device loss the transport
        // was marked lost and its handle closed; the caller gets a clear
        // DeviceRemoved instead of a bare cancellation error. If the settle
        // failed for any other reason the session stays usable but the
        // command is never resent.
        if (lost_ && !isOpen()) {
          return Result::error(ErrorCodes::kDeviceRemoved,
                               "HID device was removed while settling a timed-out write");
        }
        return Result::error(ErrorCodes::kRequestCancelled,
                             "HID write timed out with unknown cancellation outcome; the "
                             "command was NOT resent");
    }
  }
  if (wait != WAIT_OBJECT_0) {
    const DWORD waitError = GetLastError();
    io_->closeHandle(overlapped.hEvent);
    return Result::error(ErrorCodes::kInternalError, "HID write wait failed: " +
                                                          lastErrorMessage(waitError));
  }
  DWORD written = 0;
  DWORD resultError = 0;
  if (!io_->getOverlappedResult(handle_, &overlapped, written, FALSE, resultError)) {
    io_->closeHandle(overlapped.hEvent);
    return markLost(Result::error(
        isDeviceGoneError(resultError) ? ErrorCodes::kDeviceRemoved : ErrorCodes::kInternalError,
        "HID write completion failed: " + lastErrorMessage(resultError)));
  }
  io_->closeHandle(overlapped.hEvent);
  if (written != report.size()) {
    return markLost(Result::error(ErrorCodes::kWriteTimeout,
                                  "HID write completed with " + std::to_string(written) +
                                      " of " + std::to_string(report.size()) + " bytes"));
  }
  return Result::success();
}

Result CmsisDapHidTransport::overlappedRead(std::vector<uint8_t>& report, size_t& bytesRead,
                                            std::chrono::milliseconds timeout) {
  bytesRead = 0;
  OVERLAPPED overlapped{};
  overlapped.hEvent = io_->createEvent();
  if (!overlapped.hEvent) {
    return Result::error(ErrorCodes::kInternalError, "CreateEvent failed");
  }
  DWORD lastError = 0;
  const BOOL started = io_->readFile(handle_, report.data(),
                                     static_cast<DWORD>(report.size()), &overlapped, lastError);
  if (!started && lastError != ERROR_IO_PENDING) {
    io_->closeHandle(overlapped.hEvent);
    return markLost(Result::error(
        isDeviceGoneError(lastError) ? ErrorCodes::kDeviceRemoved : ErrorCodes::kInternalError,
        "HID read failed: " + lastErrorMessage(lastError)));
  }
  const DWORD wait = io_->waitForSingleObject(overlapped.hEvent,
                                              static_cast<DWORD>(timeout.count()));
  if (wait == WAIT_TIMEOUT) {
    // Settle while the OVERLAPPED and the caller's report buffer stay alive;
    // a device-loss settle error marks the transport lost and closes the
    // handle so no pending I/O can touch freed buffers.
    DWORD bytesIgnored = 0;
    const WriteOutcome outcome = settleOverlapped(overlapped, bytesIgnored);
    io_->closeHandle(overlapped.hEvent);
    switch (outcome) {
      case WriteOutcome::Cancelled:
        return Result::error(ErrorCodes::kReadTimeout,
                             "HID read timed out and cancellation was confirmed");
      case WriteOutcome::CompletedLate:
        return Result::error(ErrorCodes::kRequestCancelled,
                             "HID read completed after the timeout; no retry was issued");
      default:
        if (lost_ && !isOpen()) {
          return Result::error(ErrorCodes::kDeviceRemoved,
                               "HID device was removed while settling a timed-out read");
        }
        return Result::error(ErrorCodes::kRequestCancelled,
                             "HID read timed out with unknown outcome; no retry was issued");
    }
  }
  if (wait != WAIT_OBJECT_0) {
    const DWORD waitError = GetLastError();
    io_->closeHandle(overlapped.hEvent);
    return Result::error(ErrorCodes::kInternalError,
                         "HID read wait failed: " + lastErrorMessage(waitError));
  }
  DWORD read = 0;
  DWORD resultError = 0;
  if (!io_->getOverlappedResult(handle_, &overlapped, read, FALSE, resultError)) {
    io_->closeHandle(overlapped.hEvent);
    return markLost(Result::error(
        isDeviceGoneError(resultError) ? ErrorCodes::kDeviceRemoved : ErrorCodes::kInternalError,
        "HID read completion failed: " + lastErrorMessage(resultError)));
  }
  io_->closeHandle(overlapped.hEvent);
  bytesRead = read;
  return Result::success();
}

Result CmsisDapHidTransport::markLost(Result result) {
  lost_ = true;
  return result;
}

WriteOutcome CmsisDapHidTransport::settleOverlapped(OVERLAPPED& overlapped,
                                                    DWORD& bytesTransferred) {
  // Request cancellation. ERROR_NOT_FOUND only means no I/O was pending; it is
  // NOT proof of cancellation — the outcome is always decided by the final
  // GetOverlappedResult below.
  DWORD cancelError = 0;
  const BOOL cancelOk = io_->cancelIoEx(handle_, &overlapped, cancelError);
  (void)cancelOk;
  (void)cancelError;

  // Block until the operation reaches a definitive final state. The caller's
  // OVERLAPPED, its event and its buffer stay alive for the whole wait; the
  // kernel may still touch them until GetOverlappedResult reports a terminal
  // state, so this function NEVER returns while the operation is still in
  // flight. This is what makes it safe for the caller to release them
  // afterwards. (On cancellation the kernel sets the event and aborts the
  // operation promptly; a device that stops answering is eventually caught by
  // the I/O manager on the handle.)
  DWORD settledError = 0;
  const BOOL settledOk = io_->getOverlappedResult(handle_, &overlapped, bytesTransferred, TRUE,
                                                  settledError);
  if (settledOk != FALSE) {
    // The original I/O completed while we were cancelling: it ran to
    // completion, so a write WAS sent and must never be resent.
    return WriteOutcome::CompletedLate;
  }
  if (settledError == ERROR_OPERATION_ABORTED) {
    // Cancellation confirmed: the write provably never went out; a
    // control-transfer resend of the command is safe.
    return WriteOutcome::Cancelled;
  }
  if (isIoInFlight(settledError)) {
    // Defensive: GetOverlappedResult(TRUE) returned without a terminal state.
    // The kernel may still reference the OVERLAPPED and the buffer, so this
    // function must NOT return and let the caller release them. Treat it like
    // device loss: terminate the handle (which forces the pending operation
    // to a terminal state) and wait on the event until the kernel has
    // finished with the OVERLAPPED; only then may the caller release it.
    io_->closeHandle(handle_);
    handle_ = INVALID_HANDLE_VALUE;
    io_->waitForSingleObject(overlapped.hEvent, INFINITE);
    lost_ = true;
    return WriteOutcome::Unknown;
  }
  if (isDeviceGoneError(settledError) && settledError != ERROR_OPERATION_ABORTED) {
    // Device-loss terminal error (ERROR_DEVICE_REMOVED, ERROR_INVALID_HANDLE,
    // ERROR_DEVICE_NOT_CONNECTED, ...): the device session is over. Mark the
    // transport lost and close the handle so every later read/write fails
    // with DeviceRemoved instead of retrying a dead handle. The operation is
    // settled (the OVERLAPPED/buffer may be released) but the command's fate
    // is unknown, so it is never resent.
    lost_ = true;
    io_->closeHandle(handle_);
    handle_ = INVALID_HANDLE_VALUE;
    return WriteOutcome::Unknown;
  }
  // Other terminal error (unexpected I/O failure that is not a device-loss
  // code): the operation is settled, so the OVERLAPPED and buffer may be
  // released, but the command's fate is unknown and it is never resent. The
  // session is deliberately NOT marked lost here: the handle may still be
  // valid and the caller decides how to classify the request (the read/write
  // paths surface this as RequestCancelled, not DeviceRemoved).
  return WriteOutcome::Unknown;
}

// GetOverlappedResult reported ERROR_IO_INCOMPLETE: the kernel is still
// reading/writing the caller's OVERLAPPED and buffer. Any caller that sees
// this must keep both alive (and must not let this function's caller release
// them); a handle close forces the operation to a terminal state.
bool isIoInFlight(DWORD overlappedError) { return overlappedError == ERROR_IO_INCOMPLETE; }

// Decides the outcome of an ALREADY-SETTLED overlapped operation (the
// operation is provably no longer in flight, so its OVERLAPPED/buffer may be
// released): successful result -> CompletedLate; ERROR_OPERATION_ABORTED ->
// Cancelled; any other terminal error -> Unknown (never resend).
WriteOutcome decideSettledOutcome(bool overlappedSucceeded, DWORD overlappedError) {
  if (overlappedSucceeded) return WriteOutcome::CompletedLate;
  if (overlappedError == ERROR_OPERATION_ABORTED) return WriteOutcome::Cancelled;
  return WriteOutcome::Unknown;
}

WriteOutcome classifyWriteOutcome(bool cancelIoExOk, DWORD cancelError, DWORD cancelWait,
                                  bool overlappedSucceeded, DWORD overlappedError) {
  // GetOverlappedResult is the authoritative final-state query. A successful
  // result means the original write COMPLETED (it was sent); ERROR_OPERATION_
  // ABORTED means the cancellation was confirmed and the write never went out.
  if (overlappedSucceeded) return WriteOutcome::CompletedLate;
  if (overlappedError == ERROR_OPERATION_ABORTED) return WriteOutcome::Cancelled;
  // CancelIoEx returning ERROR_NOT_FOUND only means no I/O was pending at the
  // time of the call; it does NOT prove cancellation, and it must not be
  // treated as one. GetOverlappedResult above already decided (neither
  // completion nor abort was observed), so the outcome stays unknown.
  if (!cancelIoExOk && cancelError == ERROR_NOT_FOUND) {
    (void)cancelWait;
    return WriteOutcome::Unknown;
  }
  // The cancellation wait timed out or any other ambiguous state: unknown.
  (void)cancelIoExOk;
  (void)cancelError;
  (void)cancelWait;
  return WriteOutcome::Unknown;
}

}  // namespace cmsis_dap_helper
