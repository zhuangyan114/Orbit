#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

// CMSIS-DAP command ids implemented in this stage (official command list,
// group__DAP__Commands__gr.html).
constexpr uint8_t kCmdInfo = 0x00;
constexpr uint8_t kCmdConnect = 0x02;
constexpr uint8_t kCmdDisconnect = 0x03;
constexpr uint8_t kCmdTransferConfigure = 0x04;
constexpr uint8_t kCmdTransfer = 0x05;
constexpr uint8_t kCmdTransferBlock = 0x06;
constexpr uint8_t kCmdWriteAbort = 0x08;
constexpr uint8_t kCmdResetTarget = 0x0A;
constexpr uint8_t kCmdSwjPins = 0x10;
constexpr uint8_t kCmdSwjClock = 0x11;
constexpr uint8_t kCmdSwjSequence = 0x12;
constexpr uint8_t kCmdSwdConfigure = 0x13;

// DAP_Transfer / DAP_TransferBlock Transfer Request bitfield (official
// group__DAP__Transfer.html / group__DAP__TransferBlock.html):
//   bit0 = APnDP, bit1 = RnW, bit2 = A2, bit3 = A3.
// The A[3:2] address field therefore maps to `addr` (0..3) as (addr << 2).
// The Value Match (0x10), Match Mask (0x20) and Timestamp (0x80) bits are NOT
// supported by this stage: DapTransferItem cannot express them, so a request
// is never encoded with them, and the mock oracle refuses any raw frame that
// carries them instead of misinterpreting them.
constexpr uint8_t kRequestApnDp = 0x01;
constexpr uint8_t kRequestRnw = 0x02;
constexpr uint8_t kRequestA2 = 0x04;
constexpr uint8_t kRequestA3 = 0x08;

// DAP_Transfer / DAP_TransferBlock Transfer Response status byte flags
// (official group__DAP__Transfer.html):
//   bits 2..0 = ACK (1=OK, 2=WAIT, 4=FAULT, 7=NO_ACK), bit3 = Protocol Error
//   (SWD), bit4 = Value Mismatch (Transfer only). NO_ACK means the probe could
//   not see an ACK phase at all (target lost / protocol break) and is never
//   retried by the target layer.
constexpr uint8_t kAckOk = 0x01;
constexpr uint8_t kAckWait = 0x02;
constexpr uint8_t kAckFault = 0x04;
constexpr uint8_t kAckNoAck = 0x07;
constexpr uint8_t kTransferStatusAckMask = 0x07;
constexpr uint8_t kTransferStatusProtocolError = 0x08;
constexpr uint8_t kTransferStatusValueMismatch = 0x10;

// Legal Transfer Response status bit sets, enforced strictly BEFORE the ACK
// is interpreted so an abnormal status can never silently degrade to ACK_OK:
//   DAP_Transfer:      ACK | Protocol Error | Value Mismatch. Value Mismatch
//                      is defined by the spec, but this stage never requests
//                      Value Match reads, so the bit is always rejected.
//   DAP_TransferBlock: ACK | Protocol Error only. Bits 4..7 are undefined by
//                      the spec for the block response and are rejected.
constexpr uint8_t kTransferStatusLegalBits = 0x1F;
constexpr uint8_t kTransferBlockStatusLegalBits = 0x0F;

// DAP_Info item ids (official CMSIS-DAP spec, see group__DAP__Info.html).
constexpr uint8_t kInfoVendor = 0x01;
constexpr uint8_t kInfoProduct = 0x02;
constexpr uint8_t kInfoSerial = 0x03;
constexpr uint8_t kInfoProtocolVersion = 0x04;
constexpr uint8_t kInfoFirmwareVersion = 0x09;
constexpr uint8_t kInfoCapabilities = 0xF0;
constexpr uint8_t kInfoPacketCount = 0xFE;
constexpr uint8_t kInfoPacketSize = 0xFF;

// DAP_Connect ports (official CMSIS-DAP spec): 0=default, 1=SWD, 2=JTAG.
// The response repeats the port byte: 0 = initialization failed.
constexpr uint8_t kPortSwd = 1;
constexpr uint8_t kPortJtag = 2;

// Official status codes (group__DAP__Response__Status.html):
// 0x00 = DAP_OK, 0xFF = DAP_ERROR. Commands that are not implemented reply
// with 0xFF instead of repeating the command byte.
constexpr uint8_t kDapStatusOk = 0x00;
constexpr uint8_t kDapError = 0xFF;

// Result of a DAP_Info sweep. Empty strings / zero packet fields mean the
// device did not provide the item (legal per CMSIS-DAP: empty response item).
struct DapInfoResult {
  std::string vendor;
  std::string product;
  std::string serial;
  std::string firmwareVersion;
  std::string protocolVersion;
  std::vector<uint8_t> capabilities;  // raw capability bytes; empty = not provided
  uint16_t packetCount = 0;           // 0 = not provided
  uint16_t packetSize = 0;            // 0 = not provided
  PacketSizeSource packetSizeSource = PacketSizeSource::Unavailable;
  uint16_t effectivePacketSize = 0;   // protocol value when provided, else HID payload capacity
};

// One DAP_Transfer request item. `addr` is the 2-bit A[3:2] field (0..3),
// `ap` selects AP versus DP, `rnw` selects read versus write. The response
// carries a SINGLE Transfer Response byte for the whole batch (not one ACK
// per item): on success `ack` receives that byte (always OK) and `readData`
// the 32-bit read data of each read item, in request order. On failure the
// items before the stop point are filled with their read data; items from the
// failed transfer on must not be trusted.
struct DapTransferItem {
  bool ap = false;      // true = AP access, false = DP access
  bool rnw = false;     // true = read, false = write
  uint8_t addr = 0;     // A[3:2] field (0..3)
  uint32_t value = 0;   // write data
  uint8_t ack = 0;      // batch Transfer Response byte (0 until parsed)
  bool readDataValid = false;
  uint32_t readData = 0;
};

// Official DAP_Transfer layouts (group__DAP__Transfer.html):
//   request:  [0x05][DAP index][Transfer Count (8-bit)]
//             [Request0][Value0 (4 bytes, writes only)]... one header byte
//             per transfer, value bytes only for writes
//   response: [0x05][Count (8-bit)][Transfer Response]
//             [Read Data (4 bytes per executed read)]
// Count = number of transfers executed; Transfer Response = single status byte
// of the last executed transfer (bits 2..0 ACK, bit3 protocol error, bit4
// value mismatch); Read Data follows the status byte, one word per executed
// READ item in request order. A count below the requested count means the
// probe aborted early: the failed item and everything after it produced no
// data and must not be trusted.
//
// Official DAP_TransferBlock layouts (group__DAP__TransferBlock.html):
//   request:  [0x06][DAP index][Transfer Count (16-bit LE)][Request]
//             [Write Data (4 bytes each, writes only)]
//   response: [0x06][Count (16-bit LE)][Transfer Response]
//             [Read Data (4 bytes per executed read)]
// The response repeats a single Transfer Response byte (before the data); a
// count that differs from the requested count means the probe stopped early.
class CmsisDapProtocol {
 public:
  explicit CmsisDapProtocol(CmsisDapTransport* transport) : transport_(transport) {}

  Result getInfo(DapInfoResult& out, std::chrono::milliseconds timeout);
  Result connect(uint8_t port, uint8_t& connectedPort, std::chrono::milliseconds timeout,
                 uint32_t swjClockHz = 1000000, bool resetTargetBeforeConnect = false);
  Result disconnect(std::chrono::milliseconds timeout);

  // CMSIS-DAP SWD bring-up. DAP_Connect selects the probe port; the SWD
  // implementation then applies the complete OpenOCD-compatible 136-bit
  // JTAG-to-SWD sequence before ordinary DP/AP access. Optional transfer
  // configuration commands remain available as explicit protocol primitives.
  Result transferConfigure(uint8_t idleCycles, uint16_t waitRetryCount,
                           uint16_t matchRetryCount, std::chrono::milliseconds timeout);
  Result resetTarget(std::chrono::milliseconds timeout);
  Result swjPins(uint8_t pinOutput, uint8_t pinSelect, uint32_t waitUs,
                 std::chrono::milliseconds timeout);
  Result swjClock(uint32_t clockHz, std::chrono::milliseconds timeout);
  Result swjSequence(uint8_t bitCount, const std::vector<uint8_t>& data,
                     std::chrono::milliseconds timeout);
  Result swdConfigure(uint8_t configuration, std::chrono::milliseconds timeout);

  // Last Pin Input byte returned by DAP_SWJ_Pins in this protocol session.
  // This is diagnostic state only; a zero value is also valid when the command
  // has not been issued or the probe reports all pins low.
  uint8_t lastSwjPinInput() const { return lastSwjPinInput_; }

  // Runs a mixed read/write transfer batch. On a non-OK ACK (WAIT/FAULT/NO_ACK)
  // the call fails with the matching error code and `items` is filled up to
  // (including) the first failed item; items after it are never trusted.
  Result dapTransfer(uint8_t dapIndex, std::vector<DapTransferItem>& items,
                     std::chrono::milliseconds timeout,
                     uint8_t* completed = nullptr);

  // Writes the SW-DP ABORT register through the dedicated CMSIS-DAP command.
  // Some probes accept DP reads through DAP_Transfer but require DAP_WriteABORT
  // for clearing sticky error state.
  Result writeAbort(uint8_t dapIndex, uint32_t value,
                    std::chrono::milliseconds timeout);

  // Reads `count` words through one transfer request byte. On WAIT/FAULT the
  // probe stops early: `completed` receives the number of completed transfers.
  Result dapTransferBlockRead(uint8_t dapIndex, uint8_t request, uint16_t count,
                              std::vector<uint32_t>& values, uint8_t& ack,
                              uint16_t& completed, std::chrono::milliseconds timeout);

  // Writes `values` through one transfer request byte. A malformed or unknown
  // response is reported as kMalformedResponse/kOutcomeUnknown and the caller
  // must NOT retry the write (its completion state is unknown).
  Result dapTransferBlockWrite(uint8_t dapIndex, uint8_t request,
                               const std::vector<uint32_t>& values, uint8_t& ack,
                               uint16_t& completed, std::chrono::milliseconds timeout);

  // Effective payload capacity of one report (report length minus id byte).
  size_t payloadCapacity() const;

  // Effective CMSIS-DAP packet size established by getInfo(), 0 if unknown.
  uint16_t effectivePacketSize() const;
  void setEffectivePacketSize(uint16_t packetSize);

 private:
  Result exchange(const std::vector<uint8_t>& command, uint8_t expectedCommandId,
                  std::vector<uint8_t>& response, std::chrono::milliseconds timeout);
  Result queryInfoItem(uint8_t itemId, std::vector<uint8_t>& payload,
                       std::chrono::milliseconds timeout);

  CmsisDapTransport* transport_;
  uint16_t effectivePacketSize_ = 0;
  uint8_t lastSwjPinInput_ = 0;
};

}  // namespace cmsis_dap_helper
