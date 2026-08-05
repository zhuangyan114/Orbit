#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

// Windows CMSIS-DAP v1 HID transport.
//
// Framing rules (documented contract for the RPC layer):
//  - HidP_GetCaps Input/OutputReportByteLength include the report id byte.
//  - Effective payload capacity of one report = report length - 1.
//  - writePacket receives a command payload without the report id byte; the
//    transport writes [reportId][payload][zero padding] up to the full
//    output report length. Payloads longer than the capacity are rejected
//    with kPacketTooLarge, never truncated.
//  - readPacket reads one full input report and strips the report id byte.
//    A short read (fewer bytes than the full report) is accepted as-is:
//    CMSIS-DAP responses are variable length. A read returning only the
//    report id byte yields an empty payload which the protocol layer treats
//    as "device did not provide" where legal, or MalformedResponse where
//    the response must be non-empty.
//  - Any failed I/O after open marks the transport as deviceLost; further
//    requests fail with kDeviceRemoved instead of retrying a dead handle.
// Outcome of an overlapped write whose wait timed out, decided by
// GetOverlappedResult (the authoritative final-state query):
//  - Cancelled:      ERROR_OPERATION_ABORTED — the write is provably not in
//                    flight; a control-transfer resend of the command is safe.
//  - CompletedLate:  GetOverlappedResult succeeded — the original command WAS
//                    sent; it must never be resent.
//  - Unknown:        neither completion nor abort was observed (e.g. cancel
//                    wait timed out); the command must never be resent.
// CancelIoEx returning ERROR_NOT_FOUND only means no I/O was pending; it does
// NOT prove cancellation — the GetOverlappedResult result above decides.
enum class WriteOutcome { Cancelled, CompletedLate, Unknown };

WriteOutcome classifyWriteOutcome(bool cancelIoExOk, DWORD cancelError, DWORD cancelWait,
                                  bool overlappedSucceeded, DWORD overlappedError);

// True while an overlapped operation is still in flight: GetOverlappedResult
// reported ERROR_IO_INCOMPLETE, so the kernel may still be reading/writing the
// caller's OVERLAPPED and buffer. settleOverlapped must never return while
// this is true — the caller would release memory the kernel may still touch.
bool isIoInFlight(DWORD overlappedError);

// Decides the outcome of an already-settled overlapped operation, i.e. after
// GetOverlappedResult returned a definitive final state (the operation is no
// longer in flight and its OVERLAPPED/buffer may be released):
//  - successful result:     the I/O completed -> CompletedLate (write was sent)
//  - ERROR_OPERATION_ABORTED: cancellation was confirmed -> Cancelled
//  - any other terminal error (e.g. ERROR_DEVICE_REMOVED): the operation
//    terminated with an unknown result -> Unknown (never resend; the memory
//    may still be released because the operation is provably not in flight).
WriteOutcome decideSettledOutcome(bool overlappedSucceeded, DWORD overlappedError);

// Injection seam for the Win32 calls used by the overlapped HID I/O path. The
// real implementation wraps the Win32 APIs directly. A fake implementation can
// script the exact return values of CancelIoEx / GetOverlappedResult /
// ReadFile / WriteFile and count handle usage so the owner-loss semantics of
// the transport can be verified without real Windows overlapped I/O.
class HidIo {
 public:
  virtual ~HidIo() = default;
  virtual HANDLE createEvent() = 0;
  virtual BOOL cancelIoEx(HANDLE file, OVERLAPPED* overlapped, DWORD& lastError) = 0;
  virtual BOOL getOverlappedResult(HANDLE file, OVERLAPPED* overlapped, DWORD& bytesTransferred,
                                   BOOL wait, DWORD& lastError) = 0;
  virtual BOOL readFile(HANDLE file, void* buffer, DWORD bytesToRead, OVERLAPPED* overlapped,
                        DWORD& lastError) = 0;
  virtual BOOL writeFile(HANDLE file, const void* buffer, DWORD bytesToWrite,
                         OVERLAPPED* overlapped, DWORD& lastError) = 0;
  virtual BOOL closeHandle(HANDLE object) = 0;
  // Waits on an overlapped event. The real implementation is
  // WaitForSingleObject; the fake returns WAIT_TIMEOUT (or a scripted result)
  // so the settle path can be exercised without real events.
  virtual DWORD waitForSingleObject(HANDLE object, DWORD timeoutMs) = 0;
  // Opens the device path with FILE_FLAG_OVERLAPPED. The real implementation
  // is CreateFileW; the fake returns a scripted pseudo-handle.
  virtual HANDLE createFile(const wchar_t* path) = 0;
  // Control-transfer output report write (HidD_SetOutputReport), used only for
  // the resend of a write whose cancellation was confirmed.
  virtual BOOL setOutputReport(HANDLE file, const void* buffer, DWORD bytes) = 0;
};

class RealHidIo : public HidIo {
 public:
  HANDLE createEvent() override;
  BOOL cancelIoEx(HANDLE file, OVERLAPPED* overlapped, DWORD& lastError) override;
  BOOL getOverlappedResult(HANDLE file, OVERLAPPED* overlapped, DWORD& bytesTransferred,
                           BOOL wait, DWORD& lastError) override;
  BOOL readFile(HANDLE file, void* buffer, DWORD bytesToRead, OVERLAPPED* overlapped,
                DWORD& lastError) override;
  BOOL writeFile(HANDLE file, const void* buffer, DWORD bytesToWrite, OVERLAPPED* overlapped,
                 DWORD& lastError) override;
  BOOL closeHandle(HANDLE object) override;
  DWORD waitForSingleObject(HANDLE object, DWORD timeoutMs) override;
  HANDLE createFile(const wchar_t* path) override;
  BOOL setOutputReport(HANDLE file, const void* buffer, DWORD bytes) override;
};

class CmsisDapHidTransport : public CmsisDapTransport {
 public:
  CmsisDapHidTransport();
  explicit CmsisDapHidTransport(HidIo* io);  // self-test injection seam
  ~CmsisDapHidTransport() override;

  CmsisDapHidTransport(const CmsisDapHidTransport&) = delete;
  CmsisDapHidTransport& operator=(const CmsisDapHidTransport&) = delete;

  std::string transportName() const override { return "hid"; }

  Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) override;
  Result open(const DeviceDescriptor& device) override;
  Result close() override;
  bool isOpen() const override { return handle_ != INVALID_HANDLE_VALUE; }

  Result writePacket(const uint8_t* data, size_t length,
                     std::chrono::milliseconds timeout) override;
  Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                    std::chrono::milliseconds timeout) override;
  Result drainInput(std::chrono::milliseconds timeout) override;
  size_t payloadCapacity() const override { return payloadCapacity_; }
  bool deviceLost() const override { return lost_; }

 private:
  Result markLost(Result result);
  Result overlappedWrite(const std::vector<uint8_t>& report,
                         std::chrono::milliseconds timeout);
  Result overlappedRead(std::vector<uint8_t>& report, size_t& bytesRead,
                        std::chrono::milliseconds timeout);
  // After a wait timeout: cancels the pending overlapped operation and then
  // BLOCKS on GetOverlappedResult(..., TRUE) until the kernel reports a
  // definitive final state. The OVERLAPPED and its buffers stay alive for the
  // whole wait; the operation is provably not in flight when this returns, so
  // the caller may then release the OVERLAPPED, its event and its buffer.
  // settleOverlapped never returns while the operation is still pending and
  // never closes the device handle just to make a cancellation go away:
  //  - cancellation confirmed -> Cancelled
  //  - I/O completed late -> CompletedLate
  //  - device-loss error (ERROR_DEVICE_REMOVED, ERROR_INVALID_HANDLE, ...):
  //    the transport is marked lost and the handle is closed; returns
  //    Unknown, and the current request fails with DeviceRemoved (no resend).
  //  - any other terminal error: the operation is settled (buffers may be
  //    released) and the outcome is Unknown; the command is never resent. The
  //    session is NOT marked lost for a mere settle failure — the handle may
  //    still be valid and the caller decides how to classify the request.
  WriteOutcome settleOverlapped(OVERLAPPED& overlapped, DWORD& bytesTransferred);

  HANDLE handle_ = INVALID_HANDLE_VALUE;
  std::string path_;
  uint8_t reportId_ = 0;
  uint16_t inputReportLength_ = 0;
  uint16_t outputReportLength_ = 0;
  size_t payloadCapacity_ = 0;
  bool lost_ = false;
  // Win32 I/O seam. The real implementation wraps the Win32 API; a fake
  // implementation is injected by the self-test so the owner-loss semantics
  // are verifiable without real hardware.
  //
  // realIo_ MUST be declared before io_: C++ initializes members in
  // declaration order, and the default constructor reads realIo_.get() while
  // building io_, so realIo_ has to be constructed first. Keep this order.
  std::unique_ptr<RealHidIo> realIo_ = std::make_unique<RealHidIo>();
  HidIo* io_ = nullptr;
  // Per-open write transport mode observed for the CURRENT device session.
  // This is NOT a cached device capability: every open() starts with
  // interrupt-out and may switch to control-transfer once a timed-out write
  // provably cancelled (ERROR_OPERATION_ABORTED). open()/close() reset it.
  enum class WriteTransportMode { InterruptOut, ControlTransfer };
  WriteTransportMode transportMode_ = WriteTransportMode::InterruptOut;
};

}  // namespace cmsis_dap_helper
