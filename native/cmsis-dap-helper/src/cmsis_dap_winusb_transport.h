#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winusb.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

struct WinUsbPipeInfo {
  uint8_t endpoint = 0;
  uint16_t maximumPacketSize = 0;
  bool input = false;
};

// Injectable boundary for SetupAPI/WinUSB calls. The production implementation
// is RealWinUsbIo; tests provide a fake that scripts I/O and completion states.
class WinUsbIo {
 public:
  virtual ~WinUsbIo() = default;
  virtual Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) = 0;
  virtual HANDLE createEvent() = 0;
  virtual HANDLE createFile(const wchar_t* path) = 0;
  virtual BOOL initialize(HANDLE file, WINUSB_INTERFACE_HANDLE& interfaceHandle, DWORD& error) = 0;
  virtual BOOL queryInterfaceSettings(WINUSB_INTERFACE_HANDLE interfaceHandle,
                                      USB_INTERFACE_DESCRIPTOR& descriptor, DWORD& error) = 0;
  virtual BOOL queryPipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR index,
                         WINUSB_PIPE_INFORMATION& pipe, DWORD& error) = 0;
  virtual BOOL writePipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR endpoint,
                         PUCHAR buffer, ULONG length, PULONG transferred,
                         LPOVERLAPPED overlapped, DWORD& error) = 0;
  virtual BOOL readPipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR endpoint,
                        PUCHAR buffer, ULONG length, PULONG transferred,
                        LPOVERLAPPED overlapped, DWORD& error) = 0;
  virtual BOOL abortPipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR endpoint, DWORD& error) = 0;
  virtual BOOL getOverlappedResult(HANDLE file, LPOVERLAPPED overlapped, LPDWORD transferred,
                                   BOOL wait, DWORD& error) = 0;
  virtual DWORD waitForSingleObject(HANDLE object, DWORD timeoutMs) = 0;
  virtual BOOL freeInterface(WINUSB_INTERFACE_HANDLE interfaceHandle) = 0;
  virtual BOOL closeHandle(HANDLE object) = 0;
};

class RealWinUsbIo final : public WinUsbIo {
 public:
  Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) override;
  HANDLE createEvent() override;
  HANDLE createFile(const wchar_t* path) override;
  BOOL initialize(HANDLE file, WINUSB_INTERFACE_HANDLE& interfaceHandle, DWORD& error) override;
  BOOL queryInterfaceSettings(WINUSB_INTERFACE_HANDLE interfaceHandle,
                              USB_INTERFACE_DESCRIPTOR& descriptor, DWORD& error) override;
  BOOL queryPipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR index,
                 WINUSB_PIPE_INFORMATION& pipe, DWORD& error) override;
  BOOL writePipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR endpoint, PUCHAR buffer,
                 ULONG length, PULONG transferred, LPOVERLAPPED overlapped, DWORD& error) override;
  BOOL readPipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR endpoint, PUCHAR buffer,
                ULONG length, PULONG transferred, LPOVERLAPPED overlapped, DWORD& error) override;
  BOOL abortPipe(WINUSB_INTERFACE_HANDLE interfaceHandle, UCHAR endpoint, DWORD& error) override;
  BOOL getOverlappedResult(HANDLE file, LPOVERLAPPED overlapped, LPDWORD transferred,
                           BOOL wait, DWORD& error) override;
  DWORD waitForSingleObject(HANDLE object, DWORD timeoutMs) override;
  BOOL freeInterface(WINUSB_INTERFACE_HANDLE interfaceHandle) override;
  BOOL closeHandle(HANDLE object) override;
};

class CmsisDapWinUsbTransport final : public CmsisDapTransport {
 public:
  CmsisDapWinUsbTransport();
  explicit CmsisDapWinUsbTransport(WinUsbIo* io);
  ~CmsisDapWinUsbTransport() override;

  CmsisDapWinUsbTransport(const CmsisDapWinUsbTransport&) = delete;
  CmsisDapWinUsbTransport& operator=(const CmsisDapWinUsbTransport&) = delete;

  std::string transportName() const override { return "winusb"; }
  Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) override;
  Result open(const DeviceDescriptor& device) override;
  Result close() override;
  bool isOpen() const override { return file_ != INVALID_HANDLE_VALUE && interface_ != nullptr; }
  Result writePacket(const uint8_t* data, size_t length,
                     std::chrono::milliseconds timeout) override;
  Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                    std::chrono::milliseconds timeout) override;
  size_t payloadCapacity() const override { return payloadCapacity_; }
  Result drainInput(std::chrono::milliseconds timeout) override;
  bool deviceLost() const override { return lost_; }
  TransportIoCounters ioCounters() const override { return counters_; }

  uint8_t bulkInEndpoint() const { return bulkInEndpoint_; }
  uint8_t bulkOutEndpoint() const { return bulkOutEndpoint_; }
  uint16_t bulkInMaxPacketSize() const { return bulkInMaxPacketSize_; }
  uint16_t bulkOutMaxPacketSize() const { return bulkOutMaxPacketSize_; }

 private:
  Result markLost(Result result);
  Result transfer(bool write, std::vector<uint8_t>& buffer, size_t& transferred,
                  std::chrono::milliseconds timeout);
  Result settleTimeout(bool write, OVERLAPPED& overlapped, UCHAR endpoint, DWORD& transferred);

  std::unique_ptr<RealWinUsbIo> realIo_ = std::make_unique<RealWinUsbIo>();
  WinUsbIo* io_ = nullptr;
  HANDLE file_ = INVALID_HANDLE_VALUE;
  WINUSB_INTERFACE_HANDLE interface_ = nullptr;
  std::string path_;
  uint8_t bulkInEndpoint_ = 0;
  uint8_t bulkOutEndpoint_ = 0;
  uint16_t bulkInMaxPacketSize_ = 0;
  uint16_t bulkOutMaxPacketSize_ = 0;
  size_t payloadCapacity_ = 0;
  bool lost_ = false;
  TransportIoCounters counters_{};
};

}  // namespace cmsis_dap_helper
