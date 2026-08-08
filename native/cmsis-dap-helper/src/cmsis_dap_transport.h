#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

namespace cmsis_dap_helper {

// Structured transport result. ok=true means success; on failure errorCode
// carries a stable machine-readable code and message a human-readable one.
struct Result {
  bool ok = false;
  std::string errorCode;
  std::string message;

  static Result success() { return Result{true, "", ""}; }
  static Result error(std::string code, std::string message) {
    return Result{false, std::move(code), std::move(message)};
  }
};

// Stable error codes shared by transport and protocol layers. They are part
// of the JSON-lines RPC contract and must stay synchronized with the
// TypeScript side (src/ozone-backend/cmsis-dap-helper-channel.ts).
namespace ErrorCodes {
constexpr char kDeviceNotFound[] = "DeviceNotFound";
constexpr char kDeviceOpenFailed[] = "DeviceOpenFailed";
constexpr char kDeviceRemoved[] = "DeviceRemoved";
constexpr char kReadTimeout[] = "ReadTimeout";
constexpr char kWriteTimeout[] = "WriteTimeout";
constexpr char kMalformedResponse[] = "MalformedResponse";
constexpr char kProtocolError[] = "ProtocolError";
constexpr char kPacketTooLarge[] = "PacketTooLarge";
constexpr char kTransportNotSupported[] = "TransportNotSupported";
constexpr char kRequestCancelled[] = "RequestCancelled";
constexpr char kOutcomeUnknown[] = "OutcomeUnknown";
constexpr char kWriteCompletedLate[] = "WriteCompletedLate";
constexpr char kInvalidState[] = "InvalidState";
constexpr char kInternalError[] = "InternalError";
// DAP_Transfer / DAP_TransferBlock target ACK and request-level failures.
// These are produced by the protocol and target layers, not by the transport.
constexpr char kDapAckWait[] = "DapAckWait";        // SWD WAIT; bounded retry allowed
constexpr char kDapAckFault[] = "DapAckFault";      // SWD FAULT; clear sticky via DP ABORT first
constexpr char kDapAckNoAck[] = "DapAckNoAck";      // SWD NO_ACK / protocol break; direct failure
constexpr char kDapInvalidRequest[] = "DapInvalidRequest";  // malformed transfer request
constexpr char kDapControlTimeout[] = "DapControlTimeout";  // bounded Cortex-M control poll
constexpr char kDapAlgorithmTimeout[] = "DapAlgorithmTimeout";
constexpr char kDapAlgorithmError[] = "DapAlgorithmError";
constexpr char kDapAlgorithmHaltUnknown[] = "DapAlgorithmHaltUnknown";
constexpr char kFlashProtectionError[] = "FlashProtectionError";
constexpr char kRttInvalidControlBlock[] = "RttInvalidControlBlock";
constexpr char kRttInvalidBufferIndex[] = "RttInvalidBufferIndex";
constexpr char kRttInvalidBufferLayout[] = "RttInvalidBufferLayout";
constexpr char kRttInvalidBufferFlags[] = "RttInvalidBufferFlags";
constexpr char kRttMemoryReadFailed[] = "RttMemoryReadFailed";
constexpr char kRttMemoryWriteFailed[] = "RttMemoryWriteFailed";
constexpr char kRttBufferOverrun[] = "RttBufferOverrun";
constexpr char kRttOwnerLost[] = "RttOwnerLost";
constexpr char kRttStopped[] = "RttStopped";
}  // namespace ErrorCodes

// How the effective CMSIS-DAP packet size was derived. The protocol
// DAP_Info packet-size item may be empty on real devices (e.g. CMSIS-DAP_LU);
// in that case the HID report capability is used and the source is marked.
enum class PacketSizeSource { ProtocolInfo, HidReportCapability, UsbDescriptor, Unavailable };

struct DeviceDescriptor {
  std::string path;          // Windows device-interface path (SetupAPI)
  std::string vid;           // 4 hex chars, uppercase, e.g. "C251"
  std::string pid;           // 4 hex chars, uppercase, e.g. "F001"
  std::string manufacturer;  // may be empty
  std::string product;       // may be empty
  std::string serial;        // may be empty
  uint16_t inputReportLength = 0;   // total HID report bytes (incl. report id byte)
  uint16_t outputReportLength = 0;  // total HID report bytes (incl. report id byte)
  uint8_t reportId = 0;             // 0 means no report id / id byte still reserved
  uint16_t usagePage = 0;
  uint16_t usage = 0;
  std::string transport;     // "hid" | "winusb" | "mock" | ...
  uint8_t interfaceNumber = 0;
  uint8_t bulkInEndpoint = 0;
  uint8_t bulkOutEndpoint = 0;
  uint16_t bulkInMaxPacketSize = 0;
  uint16_t bulkOutMaxPacketSize = 0;
  uint16_t protocolPacketSize = 0;
  PacketSizeSource packetSizeSource = PacketSizeSource::Unavailable;
};

// Selector filters applied during enumeration. Empty fields are wildcards.
struct DeviceSelector {
  std::string vid;
  std::string pid;
  std::string serial;
  std::string product;
  std::string path;  // exact device path; when set, all other filters are ignored
};

struct TransportIoCounters {
  uint64_t writeReports = 0;
  uint64_t readReports = 0;
  uint64_t writePayloadBytes = 0;
  uint64_t readPayloadBytes = 0;
  uint64_t writeReportBytes = 0;
  uint64_t readReportBytes = 0;
};

// Abstract CMSIS-DAP transport. HID and mock transports implement this
// interface; the protocol layer only ever talks through it.
class CmsisDapTransport {
 public:
  virtual ~CmsisDapTransport() = default;

  // Transport name reported in diagnostics: "hid", "mock", ...
  virtual std::string transportName() const = 0;

  // Enumerates devices matching the selector. Does not open anything.
  virtual Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) = 0;

  // Opens the selected device. The descriptor must come from enumerate().
  virtual Result open(const DeviceDescriptor& device) = 0;

  // Closes the device. Idempotent.
  virtual Result close() = 0;

  virtual bool isOpen() const = 0;

  // Sends one CMSIS-DAP command packet (no report id byte, no padding).
  // The transport is responsible for report id framing and zero padding up
  // to the full output report length. Packets longer than the report payload
  // capacity are rejected with kPacketTooLarge, never truncated.
  virtual Result writePacket(const uint8_t* data, size_t length,
                             std::chrono::milliseconds timeout) = 0;

  // Receives one CMSIS-DAP response packet. Returns the effective payload
  // bytes (report id byte stripped) in `data` with `length` set. A short read
  // shorter than the full report is accepted as-is; an empty payload is
  // legal (protocol layer interprets "device did not provide").
  virtual Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                            std::chrono::milliseconds timeout) = 0;

  // Effective payload capacity of one report (report length minus id byte).
  virtual size_t payloadCapacity() const = 0;

  // Drains pending input reports (e.g. stale reports left by a previous
  // session). Implementations read until a read timeout (HID) or drop their
  // queued responses (mock). Best-effort: failures are not fatal.
  virtual Result drainInput(std::chrono::milliseconds timeout) = 0;

  // Device removal state: false until the transport observed a removal or
  // failed I/O after which it refuses further requests.
  virtual bool deviceLost() const = 0;

  // Monotonic physical-I/O counters. Callers take deltas around one RPC;
  // transport implementations count actual report attempts and bytes.
  virtual TransportIoCounters ioCounters() const = 0;
};

}  // namespace cmsis_dap_helper
