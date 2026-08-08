#include "cmsis_dap_winusb_transport.h"

#include <setupapi.h>
#include <usbiodef.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <memory>
#include <sstream>

namespace cmsis_dap_helper {
namespace {

std::string wstringToUtf8(const std::wstring& input) {
  if (input.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()),
                                      nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string output(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()), output.data(),
                      size, nullptr, nullptr);
  return output;
}

std::wstring utf8ToWide(const std::string& input) {
  if (input.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, input.c_str(), -1, nullptr, 0);
  if (size <= 0) return {};
  std::wstring output(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, input.c_str(), -1, output.data(), size);
  return output;
}

std::string idFromPath(const std::string& path, const char* key) {
  std::string lower = path;
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  const std::string needle = std::string(key) + "_";
  const size_t start = lower.find(needle);
  if (start == std::string::npos) return {};
  const size_t valueStart = start + needle.size();
  const size_t valueEnd = lower.find('&', valueStart);
  std::string value = path.substr(valueStart, valueEnd == std::string::npos ? std::string::npos
                                                                         : valueEnd - valueStart);
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  if (value.size() > 4) value.resize(4);
  return value;
}

std::string serialFromPath(const std::string& path) {
  const size_t first = path.find('#');
  if (first == std::string::npos) return {};
  const size_t second = path.find('#', first + 1);
  if (second == std::string::npos) return {};
  const size_t third = path.find('#', second + 1);
  return path.substr(second + 1, third == std::string::npos ? std::string::npos
                                                            : third - second - 1);
}

std::string errorMessage(DWORD error) {
  return "WinUSB error " + std::to_string(error);
}

bool deviceGone(DWORD error) {
  return error == ERROR_DEVICE_REMOVED || error == ERROR_DEVICE_NOT_CONNECTED ||
         error == ERROR_NO_SUCH_DEVICE || error == ERROR_INVALID_HANDLE ||
         error == ERROR_FILE_NOT_FOUND || error == ERROR_GEN_FAILURE;
}

struct HandleGuard {
  HANDLE handle = INVALID_HANDLE_VALUE;
  ~HandleGuard() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};

struct InterfaceGuard {
  WINUSB_INTERFACE_HANDLE handle = nullptr;
  ~InterfaceGuard() { if (handle) WinUsb_Free(handle); }
};

const GUID kCmsisDapV2InterfaceGuid = {
    0xCDB3B5AD, 0x293B, 0x4663, {0xAA, 0x36, 0x1A, 0xAE, 0x46, 0x46, 0x37, 0x76}};

void appendInterfacePaths(const GUID& guid, std::vector<std::wstring>& paths) {
  HDEVINFO info = SetupDiGetClassDevsW(&guid, nullptr, nullptr,
                                       DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (info == INVALID_HANDLE_VALUE) return;
  for (DWORD index = 0;; ++index) {
    SP_DEVICE_INTERFACE_DATA interfaceData{};
    interfaceData.cbSize = sizeof(interfaceData);
    if (!SetupDiEnumDeviceInterfaces(info, nullptr, &guid, index, &interfaceData)) {
      if (GetLastError() == ERROR_NO_MORE_ITEMS) break;
      continue;
    }
    DWORD required = 0;
    SetupDiGetDeviceInterfaceDetailW(info, &interfaceData, nullptr, 0, &required, nullptr);
    if (required == 0) continue;
    std::vector<uint8_t> detailBuffer(required);
    auto* detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(detailBuffer.data());
    detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
    if (!SetupDiGetDeviceInterfaceDetailW(info, &interfaceData, detail, required, nullptr, nullptr)) continue;
    const std::wstring path = detail->DevicePath;
    if (std::find(paths.begin(), paths.end(), path) == paths.end()) paths.push_back(path);
  }
  SetupDiDestroyDeviceInfoList(info);
}

}  // namespace

HANDLE RealWinUsbIo::createEvent() { return CreateEventW(nullptr, TRUE, FALSE, nullptr); }
HANDLE RealWinUsbIo::createFile(const wchar_t* path) {
  return CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
}
BOOL RealWinUsbIo::initialize(HANDLE file, WINUSB_INTERFACE_HANDLE& out, DWORD& error) {
  out = nullptr;
  const BOOL ok = WinUsb_Initialize(file, &out);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
BOOL RealWinUsbIo::queryInterfaceSettings(WINUSB_INTERFACE_HANDLE handle,
                                          USB_INTERFACE_DESCRIPTOR& descriptor, DWORD& error) {
  const BOOL ok = WinUsb_QueryInterfaceSettings(handle, 0, &descriptor);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
BOOL RealWinUsbIo::queryPipe(WINUSB_INTERFACE_HANDLE handle, UCHAR index,
                             WINUSB_PIPE_INFORMATION& pipe, DWORD& error) {
  const BOOL ok = WinUsb_QueryPipe(handle, 0, index, &pipe);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
BOOL RealWinUsbIo::writePipe(WINUSB_INTERFACE_HANDLE handle, UCHAR endpoint, PUCHAR buffer,
                             ULONG length, PULONG transferred, LPOVERLAPPED overlapped,
                             DWORD& error) {
  const BOOL ok = WinUsb_WritePipe(handle, endpoint, buffer, length, transferred, overlapped);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
BOOL RealWinUsbIo::readPipe(WINUSB_INTERFACE_HANDLE handle, UCHAR endpoint, PUCHAR buffer,
                            ULONG length, PULONG transferred, LPOVERLAPPED overlapped,
                            DWORD& error) {
  const BOOL ok = WinUsb_ReadPipe(handle, endpoint, buffer, length, transferred, overlapped);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
BOOL RealWinUsbIo::abortPipe(WINUSB_INTERFACE_HANDLE handle, UCHAR endpoint, DWORD& error) {
  const BOOL ok = WinUsb_AbortPipe(handle, endpoint);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
BOOL RealWinUsbIo::getOverlappedResult(HANDLE file, LPOVERLAPPED overlapped, LPDWORD transferred,
                                       BOOL wait, DWORD& error) {
  const BOOL ok = GetOverlappedResult(file, overlapped, transferred, wait);
  error = ok ? ERROR_SUCCESS : GetLastError();
  return ok;
}
DWORD RealWinUsbIo::waitForSingleObject(HANDLE object, DWORD timeoutMs) {
  return WaitForSingleObject(object, timeoutMs);
}
BOOL RealWinUsbIo::freeInterface(WINUSB_INTERFACE_HANDLE handle) {
  return WinUsb_Free(handle);
}
BOOL RealWinUsbIo::closeHandle(HANDLE object) { return CloseHandle(object); }

Result RealWinUsbIo::enumerate(const DeviceSelector& selector,
                               std::vector<DeviceDescriptor>& out) {
  out.clear();
  std::vector<std::wstring> interfacePaths;
  appendInterfacePaths(kCmsisDapV2InterfaceGuid, interfacePaths);
  appendInterfacePaths(GUID_DEVINTERFACE_USB_DEVICE, interfacePaths);
  for (const std::wstring& interfacePath : interfacePaths) {
    DeviceDescriptor device;
    device.path = wstringToUtf8(interfacePath);
    device.vid = idFromPath(device.path, "vid");
    device.pid = idFromPath(device.path, "pid");
    device.serial = serialFromPath(device.path);
    device.transport = "winusb";
    if (!selector.path.empty() && selector.path != device.path) continue;
    if (selector.path.empty()) {
      if (!selector.vid.empty() && selector.vid != device.vid) continue;
      if (!selector.pid.empty() && selector.pid != device.pid) continue;
      if (!selector.serial.empty() && selector.serial != device.serial) continue;
    }
    const std::wstring widePath = utf8ToWide(device.path);
    HANDLE queryFile = createFile(widePath.c_str());
    if (queryFile == INVALID_HANDLE_VALUE) continue;
    WINUSB_INTERFACE_HANDLE queryInterfaceHandle = nullptr;
    DWORD queryError = ERROR_SUCCESS;
    if (!initialize(queryFile, queryInterfaceHandle, queryError)) {
      closeHandle(queryFile);
      continue;
    }
    USB_INTERFACE_DESCRIPTOR interfaceDescriptor{};
    if (queryInterfaceSettings(queryInterfaceHandle, interfaceDescriptor, queryError)) {
      device.interfaceNumber = interfaceDescriptor.bInterfaceNumber;
      for (UCHAR endpointIndex = 0; endpointIndex < interfaceDescriptor.bNumEndpoints; ++endpointIndex) {
        WINUSB_PIPE_INFORMATION pipe{};
        if (!queryPipe(queryInterfaceHandle, endpointIndex, pipe, queryError) ||
            pipe.PipeType != UsbdPipeTypeBulk || pipe.MaximumPacketSize == 0) continue;
        if ((pipe.PipeId & 0x80) != 0 && device.bulkInEndpoint == 0) {
          device.bulkInEndpoint = pipe.PipeId;
          device.bulkInMaxPacketSize = pipe.MaximumPacketSize;
        } else if ((pipe.PipeId & 0x80) == 0 && device.bulkOutEndpoint == 0) {
          device.bulkOutEndpoint = pipe.PipeId;
          device.bulkOutMaxPacketSize = pipe.MaximumPacketSize;
        }
      }
    }
    freeInterface(queryInterfaceHandle);
    closeHandle(queryFile);
    if (device.bulkInEndpoint == 0 || device.bulkOutEndpoint == 0) continue;
    out.push_back(std::move(device));
  }
  return Result::success();
}

CmsisDapWinUsbTransport::CmsisDapWinUsbTransport() : io_(realIo_.get()) {}
CmsisDapWinUsbTransport::CmsisDapWinUsbTransport(WinUsbIo* io) : io_(io ? io : realIo_.get()) {}
CmsisDapWinUsbTransport::~CmsisDapWinUsbTransport() { close(); }

Result CmsisDapWinUsbTransport::enumerate(const DeviceSelector& selector,
                                          std::vector<DeviceDescriptor>& out) {
  return io_->enumerate(selector, out);
}

Result CmsisDapWinUsbTransport::open(const DeviceDescriptor& device) {
  if (isOpen()) return Result::error(ErrorCodes::kInvalidState, "WinUSB device is already open");
  if (device.path.empty()) return Result::error(ErrorCodes::kDeviceNotFound, "WinUSB device path is empty");
  const std::wstring path = utf8ToWide(device.path);
  if (path.empty()) return Result::error(ErrorCodes::kDeviceOpenFailed, "device path is not valid UTF-8");
  HANDLE file = io_->createFile(path.c_str());
  if (file == INVALID_HANDLE_VALUE) return Result::error(ErrorCodes::kDeviceOpenFailed, errorMessage(GetLastError()));
  WINUSB_INTERFACE_HANDLE usb = nullptr;
  DWORD error = ERROR_SUCCESS;
  if (!io_->initialize(file, usb, error)) {
    io_->closeHandle(file);
    return Result::error(ErrorCodes::kDeviceOpenFailed, "WinUsb_Initialize failed: " + errorMessage(error));
  }
  USB_INTERFACE_DESCRIPTOR descriptor{};
  if (!io_->queryInterfaceSettings(usb, descriptor, error)) {
    io_->freeInterface(usb); io_->closeHandle(file);
    return Result::error(ErrorCodes::kDeviceOpenFailed, "WinUsb_QueryInterfaceSettings failed: " + errorMessage(error));
  }
  uint8_t inEndpoint = 0, outEndpoint = 0;
  uint16_t inMax = 0, outMax = 0;
  for (UCHAR index = 0; index < descriptor.bNumEndpoints; ++index) {
    WINUSB_PIPE_INFORMATION pipe{};
    if (!io_->queryPipe(usb, index, pipe, error)) continue;
    if (pipe.PipeType != UsbdPipeTypeBulk || pipe.MaximumPacketSize == 0) continue;
    if ((pipe.PipeId & 0x80) != 0 && inEndpoint == 0) {
      inEndpoint = pipe.PipeId; inMax = pipe.MaximumPacketSize;
    } else if ((pipe.PipeId & 0x80) == 0 && outEndpoint == 0) {
      outEndpoint = pipe.PipeId; outMax = pipe.MaximumPacketSize;
    }
  }
  if (inEndpoint == 0 || outEndpoint == 0) {
    io_->freeInterface(usb); io_->closeHandle(file);
    return Result::error(ErrorCodes::kTransportNotSupported, "CMSIS-DAP v2 interface has no bulk IN/OUT pair");
  }
  file_ = file; interface_ = usb; path_ = device.path;
  bulkInEndpoint_ = inEndpoint; bulkOutEndpoint_ = outEndpoint;
  bulkInMaxPacketSize_ = inMax; bulkOutMaxPacketSize_ = outMax;
  payloadCapacity_ = device.protocolPacketSize != 0 ? device.protocolPacketSize
                                                     : (device.inputReportLength != 0 ? device.inputReportLength : 1024);
  lost_ = false; counters_ = TransportIoCounters{};
  return Result::success();
}

Result CmsisDapWinUsbTransport::close() {
  if (interface_) { io_->freeInterface(interface_); interface_ = nullptr; }
  if (file_ != INVALID_HANDLE_VALUE) { io_->closeHandle(file_); file_ = INVALID_HANDLE_VALUE; }
  lost_ = false; return Result::success();
}

Result CmsisDapWinUsbTransport::markLost(Result result) {
  lost_ = true; close(); lost_ = true; return result;
}

Result CmsisDapWinUsbTransport::writePacket(const uint8_t* data, size_t length,
                                            std::chrono::milliseconds timeout) {
  if (lost_) return Result::error(ErrorCodes::kDeviceRemoved, "WinUSB device was removed");
  if (!isOpen()) return Result::error(ErrorCodes::kInvalidState, "WinUSB device is not open");
  if (length > payloadCapacity_) return Result::error(ErrorCodes::kPacketTooLarge, "CMSIS-DAP packet exceeds WinUSB protocol capacity");
  std::vector<uint8_t> packet(data, data + length);
  size_t transferred = 0; ++counters_.writeReports; counters_.writePayloadBytes += length;
  counters_.writeReportBytes += packet.size();
  Result result = transfer(true, packet, transferred, timeout);
  return result;
}

Result CmsisDapWinUsbTransport::readPacket(uint8_t* data, size_t capacity, size_t& length,
                                           std::chrono::milliseconds timeout) {
  length = 0;
  if (lost_) return Result::error(ErrorCodes::kDeviceRemoved, "WinUSB device was removed");
  if (!isOpen()) return Result::error(ErrorCodes::kInvalidState, "WinUSB device is not open");
  std::vector<uint8_t> packet(payloadCapacity_, 0); size_t transferred = 0;
  ++counters_.readReports;
  const Result result = transfer(false, packet, transferred, timeout);
  if (!result.ok) return result;
  if (transferred > capacity) return Result::error(ErrorCodes::kMalformedResponse, "WinUSB response exceeds caller capacity");
  if (transferred > 0) std::memcpy(data, packet.data(), transferred);
  counters_.readPayloadBytes += transferred; counters_.readReportBytes += transferred;
  length = transferred;
  return Result::success();
}

Result CmsisDapWinUsbTransport::drainInput(std::chrono::milliseconds timeout) {
  if (!isOpen() || lost_) return Result::success();
  std::vector<uint8_t> packet(payloadCapacity_, 0); size_t transferred = 0;
  for (int i = 0; i < 16; ++i) {
    const Result result = transfer(false, packet, transferred, timeout);
    if (!result.ok) break;
    if (transferred == 0) break;
  }
  return Result::success();
}

Result CmsisDapWinUsbTransport::transfer(bool write, std::vector<uint8_t>& buffer, size_t& transferred,
                                         std::chrono::milliseconds timeout) {
  transferred = 0;
  OVERLAPPED overlapped{}; overlapped.hEvent = io_->createEvent();
  if (!overlapped.hEvent) return Result::error(ErrorCodes::kInternalError, "CreateEvent failed");
  DWORD bytes = 0, error = ERROR_SUCCESS;
  const BOOL started = write
      ? io_->writePipe(interface_, bulkOutEndpoint_, buffer.data(), static_cast<ULONG>(buffer.size()), &bytes, &overlapped, error)
      : io_->readPipe(interface_, bulkInEndpoint_, buffer.data(), static_cast<ULONG>(buffer.size()), &bytes, &overlapped, error);
  if (started) {
    io_->closeHandle(overlapped.hEvent);
    transferred = bytes;
    return Result::success();
  }
  if (!started && error != ERROR_IO_PENDING) {
    io_->closeHandle(overlapped.hEvent);
    if (deviceGone(error)) return markLost(Result::error(ErrorCodes::kDeviceRemoved, errorMessage(error)));
    return Result::error(write ? ErrorCodes::kWriteTimeout : ErrorCodes::kReadTimeout, errorMessage(error));
  }
  const DWORD wait = io_->waitForSingleObject(overlapped.hEvent, static_cast<DWORD>(std::max<int64_t>(0, timeout.count())));
  if (wait == WAIT_TIMEOUT) {
    const Result settled = settleTimeout(write, overlapped, write ? bulkOutEndpoint_ : bulkInEndpoint_, bytes);
    io_->closeHandle(overlapped.hEvent); return settled;
  }
  DWORD finalError = ERROR_SUCCESS;
  if (!io_->getOverlappedResult(file_, &overlapped, &bytes, TRUE, finalError)) {
    io_->closeHandle(overlapped.hEvent);
    if (deviceGone(finalError)) return markLost(Result::error(ErrorCodes::kDeviceRemoved, errorMessage(finalError)));
    return Result::error(write ? ErrorCodes::kWriteTimeout : ErrorCodes::kReadTimeout, errorMessage(finalError));
  }
  io_->closeHandle(overlapped.hEvent); transferred = bytes; return Result::success();
}

Result CmsisDapWinUsbTransport::settleTimeout(bool write, OVERLAPPED& overlapped, UCHAR endpoint,
                                              DWORD& transferred) {
  DWORD abortError = ERROR_SUCCESS;
  io_->abortPipe(interface_, endpoint, abortError);
  DWORD finalError = ERROR_SUCCESS;
  if (io_->getOverlappedResult(file_, &overlapped, &transferred, TRUE, finalError)) {
    return Result::error(write ? ErrorCodes::kWriteCompletedLate : ErrorCodes::kReadTimeout,
                         write ? "WinUSB write completed after timeout; not resent" : "WinUSB read timed out");
  }
  if (finalError == ERROR_OPERATION_ABORTED) {
    return Result::error(write ? ErrorCodes::kWriteTimeout : ErrorCodes::kReadTimeout,
                         "WinUSB I/O cancellation confirmed");
  }
  if (deviceGone(finalError)) return markLost(Result::error(ErrorCodes::kDeviceRemoved, errorMessage(finalError)));
  return Result::error(write ? ErrorCodes::kOutcomeUnknown : ErrorCodes::kReadTimeout,
                       "WinUSB I/O completion outcome is unknown");
}

}  // namespace cmsis_dap_helper
