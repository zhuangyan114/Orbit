#include "cmsis_dap_protocol.h"

#include <cstdlib>
#include <iostream>
#include <sstream>

#include "trace_control.h"

namespace cmsis_dap_helper {

namespace {

std::string hexByte(uint8_t value) {
  char buffer[3];
  std::snprintf(buffer, sizeof(buffer), "%02X", value);
  return std::string(buffer);
}

std::string hexDump(const std::vector<uint8_t>& bytes, size_t maxBytes = 24) {
  std::string out;
  const size_t shown = bytes.size() < maxBytes ? bytes.size() : maxBytes;
  for (size_t i = 0; i < shown; ++i) {
    if (i > 0) out += " ";
    out += hexByte(bytes[i]);
  }
  if (bytes.size() > shown) out += " ...";
  return out;
}

uint32_t readLe32(const std::vector<uint8_t>& bytes, size_t offset) {
  return static_cast<uint32_t>(bytes[offset]) |
         (static_cast<uint32_t>(bytes[offset + 1]) << 8) |
         (static_cast<uint32_t>(bytes[offset + 2]) << 16) |
         (static_cast<uint32_t>(bytes[offset + 3]) << 24);
}

std::string ackName(uint8_t ack) {
  switch (ack) {
    case kAckOk: return "OK";
    case kAckWait: return "WAIT";
    case kAckFault: return "FAULT";
    case kAckNoAck: return "NO_ACK";
    default: return "0x" + hexByte(ack);
  }
}

std::string ackErrorCode(uint8_t ack) {
  switch (ack) {
    case kAckWait: return ErrorCodes::kDapAckWait;
    case kAckFault: return ErrorCodes::kDapAckFault;
    case kAckNoAck: return ErrorCodes::kDapAckNoAck;
    default: return "";  // unknown ACK value = malformed response
  }
}

// Strictly validates one Transfer Response status byte. Reserved/unknown
// bits are rejected BEFORE the ACK is read, so an abnormal status can never
// silently degrade into ACK_OK (e.g. 0x21 must not be read as OK).
// `blockMode` selects the DAP_TransferBlock rules (bits 4..7 undefined and
// rejected) versus the DAP_Transfer rules (bit4 = Value Mismatch defined but
// unsupported, bits 5..7 reserved). On success `ack` receives the ACK value.
Result validateTransferStatus(uint8_t status, bool blockMode, uint8_t& ack) {
  const uint8_t legalBits =
      blockMode ? kTransferBlockStatusLegalBits : kTransferStatusLegalBits;
  if ((status & ~legalBits) != 0) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "response carries reserved status bits (status=0x" + hexByte(status) +
                             ")");
  }
  if ((status & kTransferStatusProtocolError) != 0) {
    return Result::error(ErrorCodes::kProtocolError,
                         "response reports SWD protocol error (status=0x" + hexByte(status) +
                             ")");
  }
  if ((status & kTransferStatusValueMismatch) != 0) {
    // DAP_Transfer defines bit4 as Value Mismatch; Value Match reads are
    // never requested by this stage, so the flag is always an error.
    return Result::error(ErrorCodes::kProtocolError,
                         "response reports value mismatch (never requested; status=0x" +
                             hexByte(status) + ")");
  }
  ack = status & kTransferStatusAckMask;
  if (ack != kAckOk && ack != kAckWait && ack != kAckFault && ack != kAckNoAck) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "response has invalid ACK value (status=0x" + hexByte(status) + ")");
  }
  return Result::success();
}

Result validateCommandResponse(const std::vector<uint8_t>& response, uint8_t command,
                               bool hasStatus) {
  if (response.empty() || response[0] != command) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "CMSIS-DAP command 0x" + hexByte(command) +
                             " returned an unexpected response");
  }
  if (!hasStatus) return Result::success();
  if (response.size() < 2) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "CMSIS-DAP command 0x" + hexByte(command) +
                             " response is missing its status byte");
  }
  if (response[1] != kDapStatusOk) {
    return Result::error(ErrorCodes::kProtocolError,
                         "CMSIS-DAP command 0x" + hexByte(command) +
                             " returned status 0x" + hexByte(response[1]));
  }
  return Result::success();
}

}  // namespace

Result CmsisDapProtocol::exchange(const std::vector<uint8_t>& command, uint8_t expectedCommandId,
                                  std::vector<uint8_t>& response,
                                  std::chrono::milliseconds timeout) {
  if (!transport_) {
    return Result::error(ErrorCodes::kInternalError, "no transport bound to protocol layer");
  }
  if (rawTraceEnabled()) {
    std::cerr << "[cmsis-dap-protocol] tx length=" << command.size()
              << " bytes=" << hexDump(command, command.size()) << std::endl;
  }
  const Result writeResult = transport_->writePacket(command.data(), command.size(), timeout);
  if (!writeResult.ok) {
    if (rawTraceEnabled()) {
      std::cerr << "[cmsis-dap-protocol] tx failed length=" << command.size()
                << " bytes=" << hexDump(command, command.size())
                << " code=" << writeResult.errorCode << " message=" << writeResult.message
                << std::endl;
    }
    return writeResult;
  }

  response.clear();
  const size_t capacity = transport_->payloadCapacity();
  if (capacity == 0) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "transport reports zero payload capacity");
  }
  std::vector<uint8_t> buffer(capacity);
  size_t length = 0;
  const Result readResult = transport_->readPacket(buffer.data(), buffer.size(), length, timeout);
  if (!readResult.ok) {
    if (rawTraceEnabled()) {
      std::cerr << "[cmsis-dap-protocol] rx failed command=" << hexDump(command)
                << " code=" << readResult.errorCode << " message=" << readResult.message
                << std::endl;
    }
    return readResult;
  }
  response.assign(buffer.data(), buffer.data() + length);
  if (rawTraceEnabled()) {
    std::cerr << "[cmsis-dap-protocol] rx length=" << response.size()
              << " bytes=" << hexDump(response, response.size()) << std::endl;
  }

  if (response.empty() || response[0] != expectedCommandId) {
    // The report may be stale data left by a previous request (some firmware
    // keeps old bytes in its report buffer). Try one more read with a short
    // timeout before giving up; a failed retry keeps the first result.
    size_t retryLength = 0;
    const std::chrono::milliseconds retryTimeout =
        timeout > std::chrono::milliseconds(200) ? std::chrono::milliseconds(200) : timeout;
    const Result retryResult =
        transport_->readPacket(buffer.data(), buffer.size(), retryLength, retryTimeout);
    if (retryResult.ok && retryLength > 0 && buffer[0] == expectedCommandId) {
      response.assign(buffer.data(), buffer.data() + retryLength);
    }
  }

  if (response.empty()) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "empty response for command 0x" + hexByte(command[0]));
  }
  if (response[0] != expectedCommandId) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "response command id 0x" + hexByte(response[0]) +
                             " does not match expected 0x" + hexByte(expectedCommandId) +
                             "; response=" + hexDump(response));
  }
  return Result::success();
}

Result CmsisDapProtocol::queryInfoItem(uint8_t itemId, std::vector<uint8_t>& payload,
                                       std::chrono::milliseconds timeout) {
  payload.clear();
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange({kCmdInfo, itemId}, kCmdInfo, response, timeout);
  if (!exchangeResult.ok) {
    return Result::error(exchangeResult.errorCode,
                         "DAP_Info(0x" + hexByte(itemId) + ") failed: " + exchangeResult.message);
  }
  // Official layout (group__DAP__Info.html): [command=0x00][length][info bytes].
  // The response does NOT echo the info id. length=0 means no information
  // (also returned for unrecognized ids); strings are UTF-8 with a NUL
  // terminator and the length includes that NUL. HID reports always carry the
  // full report length, so trailing bytes beyond `length` are padding/residue
  // and ignored. Multi-report responses (length > 62) are not reassembled in
  // this stage and are rejected explicitly rather than truncated silently.
  if (response.size() < 2) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_Info(0x" + hexByte(itemId) + ") response is shorter than 2 bytes");
  }
  const size_t declaredLength = response[1];
  if (declaredLength > response.size() - 2) {
    return Result::error(
        ErrorCodes::kMalformedResponse,
        "DAP_Info(0x" + hexByte(itemId) + ") response declares " +
            std::to_string(declaredLength) + " bytes but carries " +
            std::to_string(response.size() - 2) +
            " (multi-report responses are not reassembled in this stage); response=" +
            hexDump(response));
  }
  payload.assign(response.begin() + 2, response.begin() + 2 + declaredLength);
  return Result::success();
}

Result CmsisDapProtocol::getInfo(DapInfoResult& out, std::chrono::milliseconds timeout) {
  out = DapInfoResult{};
  struct StringItem {
    uint8_t id;
    std::string* target;
  };
  const StringItem stringItems[] = {
      {kInfoVendor, &out.vendor},
      {kInfoProduct, &out.product},
      {kInfoSerial, &out.serial},
      {kInfoProtocolVersion, &out.protocolVersion},
      {kInfoFirmwareVersion, &out.firmwareVersion},
  };
  for (const StringItem& item : stringItems) {
    std::vector<uint8_t> payload;
    const Result result = queryInfoItem(item.id, payload, timeout);
    if (!result.ok) return result;
    // Official layout: strings include the NUL terminator in their length.
    while (!payload.empty() && payload.back() == 0) payload.pop_back();
    item.target->assign(payload.begin(), payload.end());
  }

  std::vector<uint8_t> capabilities;
  Result result = queryInfoItem(kInfoCapabilities, capabilities, timeout);
  if (!result.ok) return result;
  out.capabilities = std::move(capabilities);

  std::vector<uint8_t> packetCount;
  result = queryInfoItem(kInfoPacketCount, packetCount, timeout);
  if (!result.ok) return result;
  if (!packetCount.empty()) {
    out.packetCount = packetCount[0];  // official: Packet Count is a BYTE
  }

  std::vector<uint8_t> packetSize;
  result = queryInfoItem(kInfoPacketSize, packetSize, timeout);
  if (!result.ok) return result;
  if (packetSize.size() >= 2) {
    // official: Packet Size is a little-endian SHORT
    out.packetSize = static_cast<uint16_t>(packetSize[0] | (packetSize[1] << 8));
  }

  if (out.packetSize != 0) {
    out.packetSizeSource = PacketSizeSource::ProtocolInfo;
    out.effectivePacketSize = out.packetSize;
  } else if (transport_->payloadCapacity() > 0) {
    out.packetSizeSource = transport_->transportName() == "winusb"
                               ? PacketSizeSource::UsbDescriptor
                               : PacketSizeSource::HidReportCapability;
    out.effectivePacketSize = static_cast<uint16_t>(transport_->payloadCapacity());
  } else {
    out.packetSizeSource = PacketSizeSource::Unavailable;
  }
  return Result::success();
}

Result CmsisDapProtocol::connect(uint8_t port, uint8_t& connectedPort,
                                 std::chrono::milliseconds timeout, uint32_t swjClockHz,
                                 bool resetTargetBeforeConnect) {
  connectedPort = 0;
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange({kCmdConnect, port}, kCmdConnect, response, timeout);
  if (!exchangeResult.ok) {
    return Result::error(exchangeResult.errorCode,
                         "DAP_Connect failed: " + exchangeResult.message);
  }
  // Official layout (group__DAP__Connect.html): response is [0x02][Port].
  //   Port = 0: initialization failed; 1: SWD; 2: JTAG.
  // The reported port is passed through verbatim, never invented. There is no
  // status byte in the official layout; older vendor layouts with an extra
  // status byte are NOT auto-accepted (no hardware evidence; see mock device
  // 1234:567D which is created but disabled until a real device needs it).
  if (response.size() < 2) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_Connect response must be at least 2 bytes; response=" +
                             hexDump(response));
  }
  const uint8_t connectPort = response[1];
  if (connectPort != 0 && connectPort != kPortSwd && connectPort != kPortJtag) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_Connect returned invalid port 0x" + hexByte(connectPort) +
                             "; response=" + hexDump(response));
  }
  if (connectPort == 0) {
    return Result::error(ErrorCodes::kProtocolError,
                         "DAP_Connect failed: device reports port 0 (initialization failed)");
  }
  connectedPort = connectPort;

  // DAP_ResetTarget is optional in the CMSIS-DAP contract; a probe that
  // reports it unsupported is allowed to continue and the subsequent DP
  // probe remains the authority for target availability.
  if (resetTargetBeforeConnect) {
    const Result resetResult = resetTarget(timeout);
    if (!resetResult.ok && resetResult.errorCode != ErrorCodes::kProtocolError &&
        resetResult.errorCode != ErrorCodes::kMalformedResponse) {
      return resetResult;
    }
  }
  // DAP_Connect selects the probe's SWD port, but it does not guarantee that
  // the target SWJ-DP is already in SWD state. Match OpenOCD's complete
  // JTAG-to-SWD sequence: 56 high cycles, 0xE79E LSB-first, 56 high cycles,
  // and 8 low idle cycles. Keep it as one command so the probe clocks the
  // sequence without an inter-command gap.
  Result initResult = swjClock(swjClockHz == 0 ? 1000000u : swjClockHz, timeout);
  if (!initResult.ok) return initResult;
  if (connectPort == kPortSwd) {
    const std::vector<uint8_t> jtagToSwd = {
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0x9E, 0xE7,
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0x00};
    initResult = swjSequence(136, jtagToSwd, timeout);
    if (!initResult.ok) return initResult;
    initResult = swjClock(swjClockHz == 0 ? 1000000u : swjClockHz, timeout);
    if (!initResult.ok) return initResult;
  }
  // Match the CMSIS-DAP initialization used by OpenOCD and the reference
  // DAPLink implementation: explicitly select one SWD turnaround cycle and
  // disable the optional data phase before the first DP/AP transfer. Some
  // CMSIS-DAP-LU firmware leaves this state undefined after DAP_Connect;
  // reads may still work while writes return SWD NO_ACK until it is set.
  if (connectPort == kPortSwd) {
    initResult = transferConfigure(0, 64, 0, timeout);
    if (!initResult.ok) return initResult;
    initResult = swdConfigure(0x00, timeout);
    if (!initResult.ok) return initResult;

    // A SWD line reset leaves the DP in the ADIv5 connection-reset state.
    // The first access after the JTAG-to-SWD sequence must be a DP DPIDR
    // read; until it completes, other DP accesses are not required to drive
    // SWDIO. OpenOCD performs this read before clearing ABORT/powering the
    // debug domain. Without the prime read, this probe returns NO_ACK for the
    // first DP write even though DPIDR reads succeed when issued separately.
    std::vector<DapTransferItem> primeItems(1);
    primeItems[0].ap = false;
    primeItems[0].rnw = true;
    primeItems[0].addr = 0;
    uint8_t completed = 0;
    initResult = dapTransfer(0, primeItems, timeout, &completed);
    if (!initResult.ok) {
      return Result::error(initResult.errorCode,
                           "SWD DP IDCODE prime read failed: " + initResult.message);
    }
    if (completed != 1 || !primeItems[0].readDataValid) {
      return Result::error(ErrorCodes::kMalformedResponse,
                           "SWD DP IDCODE prime read did not return one data word");
    }
  }
  return Result::success();
}

Result CmsisDapProtocol::transferConfigure(uint8_t idleCycles, uint16_t waitRetryCount,
                                            uint16_t matchRetryCount,
                                            std::chrono::milliseconds timeout) {
  const std::vector<uint8_t> request = {
      kCmdTransferConfigure,
      idleCycles,
      static_cast<uint8_t>(waitRetryCount & 0xFF),
      static_cast<uint8_t>((waitRetryCount >> 8) & 0xFF),
      static_cast<uint8_t>(matchRetryCount & 0xFF),
      static_cast<uint8_t>((matchRetryCount >> 8) & 0xFF),
  };
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(request, kCmdTransferConfigure, response, timeout);
  if (!exchangeResult.ok) return exchangeResult;
  return validateCommandResponse(response, kCmdTransferConfigure, false);
}

Result CmsisDapProtocol::resetTarget(std::chrono::milliseconds timeout) {
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange({kCmdResetTarget}, kCmdResetTarget, response, timeout);
  if (!exchangeResult.ok) return exchangeResult;
  return validateCommandResponse(response, kCmdResetTarget, true);
}

Result CmsisDapProtocol::swjPins(uint8_t pinOutput, uint8_t pinSelect, uint32_t waitUs,
                                 std::chrono::milliseconds timeout) {
  const std::vector<uint8_t> request = {
      kCmdSwjPins,
      pinOutput,
      pinSelect,
      static_cast<uint8_t>(waitUs & 0xFF),
      static_cast<uint8_t>((waitUs >> 8) & 0xFF),
      static_cast<uint8_t>((waitUs >> 16) & 0xFF),
      static_cast<uint8_t>((waitUs >> 24) & 0xFF),
  };
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(request, kCmdSwjPins, response, timeout);
  if (!exchangeResult.ok) return exchangeResult;
  if (response.size() < 2) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_SWJ_Pins response is missing pin input state");
  }
  lastSwjPinInput_ = response[1];
  return Result::success();
}

Result CmsisDapProtocol::swjClock(uint32_t clockHz, std::chrono::milliseconds timeout) {
  std::vector<uint8_t> request = {kCmdSwjClock,
                                  static_cast<uint8_t>(clockHz & 0xFF),
                                  static_cast<uint8_t>((clockHz >> 8) & 0xFF),
                                  static_cast<uint8_t>((clockHz >> 16) & 0xFF),
                                  static_cast<uint8_t>((clockHz >> 24) & 0xFF)};
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(request, kCmdSwjClock, response, timeout);
  if (!exchangeResult.ok) return exchangeResult;
  return validateCommandResponse(response, kCmdSwjClock, true);
}

Result CmsisDapProtocol::swjSequence(uint8_t bitCount, const std::vector<uint8_t>& data,
                                     std::chrono::milliseconds timeout) {
  if (bitCount == 0 || data.size() != (static_cast<size_t>(bitCount) + 7) / 8) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "DAP_SWJ_Sequence requires exactly ceil(bitCount/8) data bytes");
  }
  std::vector<uint8_t> request = {kCmdSwjSequence, bitCount};
  request.insert(request.end(), data.begin(), data.end());
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(request, kCmdSwjSequence, response, timeout);
  if (!exchangeResult.ok) return exchangeResult;
  return validateCommandResponse(response, kCmdSwjSequence, true);
}

Result CmsisDapProtocol::swdConfigure(uint8_t configuration,
                                      std::chrono::milliseconds timeout) {
  std::vector<uint8_t> response;
  const Result exchangeResult =
      exchange({kCmdSwdConfigure, configuration}, kCmdSwdConfigure, response, timeout);
  if (!exchangeResult.ok) return exchangeResult;
  return validateCommandResponse(response, kCmdSwdConfigure, true);
}

Result CmsisDapProtocol::disconnect(std::chrono::milliseconds timeout) {
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange({kCmdDisconnect}, kCmdDisconnect, response, timeout);
  if (!exchangeResult.ok) {
    return Result::error(exchangeResult.errorCode,
                         "DAP_Disconnect failed: " + exchangeResult.message);
  }
  // Official v2 layout (group__DAP__Disconnect.html): [0x03][Status]. The v1
  // legacy layout is a single [0x03] byte; both are accepted. Status is
  // DAP_OK (0x00) or DAP_ERROR (0xFF); any non-zero status is an error.
  if (response.size() < 1) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_Disconnect response is empty");
  }
  if (response.size() >= 2 && response[1] != kDapStatusOk) {
    return Result::error(ErrorCodes::kProtocolError,
                         "DAP_Disconnect returned status 0x" + hexByte(response[1]) +
                             (response[1] == kDapError ? " (DAP_ERROR)" : ""));
  }
  return Result::success();
}

Result CmsisDapProtocol::dapTransfer(uint8_t dapIndex, std::vector<DapTransferItem>& items,
                                     std::chrono::milliseconds timeout,
                                     uint8_t* completed) {
  if (completed) *completed = 0;
  if (items.empty() || items.size() > 255) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "DAP_Transfer requires 1..255 transfers, got " +
                             std::to_string(items.size()));
  }
  std::vector<uint8_t> request;
  request.reserve(3 + items.size() * 5);
  request.push_back(kCmdTransfer);
  request.push_back(dapIndex);
  request.push_back(static_cast<uint8_t>(items.size()));
  for (const DapTransferItem& item : items) {
    // Official Transfer Request byte: bit0 APnDP, bit1 RnW, bits 3:2 A[3:2].
    // Match/Mask/Timestamp are not expressible through DapTransferItem and
    // must never leak into a request silently.
    uint8_t header = static_cast<uint8_t>((item.ap ? kRequestApnDp : 0x00) |
                                          (item.rnw ? kRequestRnw : 0x00) |
                                          ((item.addr & 0x03) << 2));
    request.push_back(header);
    if (item.rnw) {
      continue;
    }
    request.push_back(static_cast<uint8_t>(item.value & 0xFF));
    request.push_back(static_cast<uint8_t>((item.value >> 8) & 0xFF));
    request.push_back(static_cast<uint8_t>((item.value >> 16) & 0xFF));
    request.push_back(static_cast<uint8_t>((item.value >> 24) & 0xFF));
  }
  const size_t capacity = payloadCapacity();
  if (capacity != 0 && request.size() > capacity) {
    return Result::error(ErrorCodes::kPacketTooLarge,
                         "DAP_Transfer request of " + std::to_string(request.size()) +
                             " bytes exceeds packet capacity " + std::to_string(capacity));
  }

  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(request, kCmdTransfer, response, timeout);
  if (!exchangeResult.ok) {
    return Result::error(exchangeResult.errorCode,
                         "DAP_Transfer failed: " + exchangeResult.message);
  }
  // Official response layout: [0x05][Count][Transfer Response][Read Data...].
  // Count = number of transfers executed; Transfer Response = ONE status byte
  // describing the last executed transfer (bits 2..0 = ACK, bit3 = protocol
  // error, bit4 = value mismatch); Read Data follows it, one LE32 word per
  // executed READ item in request order. Every length/count inconsistency is
  // rejected as kMalformedResponse, never silently truncated.
  if (response.size() < 3) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_Transfer response is shorter than 3 bytes; response=" +
                             hexDump(response));
  }
  const uint8_t responseCount = response[1];
  if (completed) *completed = responseCount;
  if (responseCount > items.size()) {
    return Result::error(
        ErrorCodes::kMalformedResponse,
        "DAP_Transfer response count " + std::to_string(responseCount) +
            " exceeds requested " + std::to_string(items.size()) + "; response=" +
            hexDump(response));
  }
  size_t executedReads = 0;
  for (size_t i = 0; i < responseCount; ++i) {
    if (items[i].rnw) ++executedReads;
  }
  // The response must carry at least the declared read data. Real HID
  // firmware pads every input report to the full report length with stale
  // bytes, so trailing bytes beyond the declared data are padding and are
  // ignored - never a reason to reject the response. A response SHORTER than
  // its declared count is truncated and rejected.
  const size_t minimumLength = 3 + executedReads * 4;
  if (response.size() < minimumLength) {
    return Result::error(
        ErrorCodes::kMalformedResponse,
        "DAP_Transfer response length " + std::to_string(response.size()) +
            " is shorter than the " + std::to_string(executedReads) +
            " declared read(s) (truncated); response=" + hexDump(response));
  }
  const uint8_t status = response[2];
  uint8_t ack = 0;
  const Result statusResult = validateTransferStatus(status, false, ack);
  if (!statusResult.ok) {
    return Result::error(statusResult.errorCode,
                         "DAP_Transfer " + statusResult.message + "; response=" +
                             hexDump(response));
  }
  // Fill the read data of the transfers the probe DID execute (they are
  // trustworthy), then fail for anything short of the full batch.
  size_t dataOffset = 3;
  for (size_t i = 0; i < responseCount; ++i) {
    items[i].ack = status;
    if (items[i].rnw) {
      items[i].readData = readLe32(response, dataOffset);
      items[i].readDataValid = true;
      dataOffset += 4;
    }
  }
  if (responseCount < items.size()) {
    // The probe aborted after responseCount transfers. The failed transfer
    // and everything after it produced no data and must not be trusted.
    if (ack == kAckOk) {
      return Result::error(
          ErrorCodes::kMalformedResponse,
          "DAP_Transfer response completed " + std::to_string(responseCount) + " of " +
              std::to_string(items.size()) + " transfers but reports ACK=OK; response=" +
              hexDump(response));
    }
    return Result::error(ackErrorCode(ack),
                         "DAP_Transfer stopped after " + std::to_string(responseCount) + " of " +
                             std::to_string(items.size()) + " transfers, status ACK=" +
                             ackName(ack));
  }
  if (ack != kAckOk) {
    // Every requested transfer executed, yet the final status is not OK.
    // The response byte still describes the last transfer: fail explicitly.
    return Result::error(ackErrorCode(ack),
                         "DAP_Transfer completed " + std::to_string(responseCount) +
                             " transfers with final status ACK=" + ackName(ack));
  }
  return Result::success();
}

Result CmsisDapProtocol::writeAbort(uint8_t dapIndex, uint32_t value,
                                     std::chrono::milliseconds timeout) {
  // Official DAP_WriteABORT layout: [0x08][DAP index][ABORT value LE32].
  const std::vector<uint8_t> command = {
      kCmdWriteAbort,
      dapIndex,
      static_cast<uint8_t>(value & 0xFF),
      static_cast<uint8_t>((value >> 8) & 0xFF),
      static_cast<uint8_t>((value >> 16) & 0xFF),
      static_cast<uint8_t>((value >> 24) & 0xFF),
  };
  const size_t capacity = payloadCapacity();
  if (capacity != 0 && command.size() > capacity) {
    return Result::error(ErrorCodes::kPacketTooLarge,
                         "DAP_WriteABORT request of " + std::to_string(command.size()) +
                             " bytes exceeds packet capacity " + std::to_string(capacity));
  }
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(command, kCmdWriteAbort, response, timeout);
  if (!exchangeResult.ok) {
    return Result::error(exchangeResult.errorCode,
                         "DAP_WriteABORT failed: " + exchangeResult.message);
  }
  return validateCommandResponse(response, kCmdWriteAbort, true);
}

Result CmsisDapProtocol::dapTransferBlockRead(uint8_t dapIndex, uint8_t request, uint16_t count,
                                              std::vector<uint32_t>& values, uint8_t& ack,
                                              uint16_t& completed,
                                              std::chrono::milliseconds timeout) {
  values.clear();
  ack = 0;
  completed = 0;
  if (count == 0) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "DAP_TransferBlock read requires count >= 1");
  }
  // Official request: [0x06][DAP index][Count (16-bit LE)][Transfer Request].
  std::vector<uint8_t> command = {kCmdTransferBlock, dapIndex,
                                  static_cast<uint8_t>(count & 0xFF),
                                  static_cast<uint8_t>((count >> 8) & 0xFF), request};
  const size_t capacity = payloadCapacity();
  if (capacity != 0 && command.size() > capacity) {
    return Result::error(ErrorCodes::kPacketTooLarge,
                         "DAP_TransferBlock read request of " +
                             std::to_string(command.size()) + " bytes exceeds packet capacity " +
                             std::to_string(capacity));
  }
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(command, kCmdTransferBlock, response, timeout);
  if (!exchangeResult.ok) {
    return Result::error(exchangeResult.errorCode,
                         "DAP_TransferBlock read failed: " + exchangeResult.message);
  }
  // Official response: [0x06][Count (16-bit LE)][Transfer Response][Read Data...].
  // Trailing bytes beyond the declared data are HID report padding (the real
  // firmware pads every report to the full report length) and are ignored; a
  // response shorter than its declared data is truncated and rejected.
  if (response.size() < 4) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_TransferBlock read response is shorter than 4 bytes; response=" +
                             hexDump(response));
  }
  const uint16_t responseCount =
      static_cast<uint16_t>(response[1] | (static_cast<uint16_t>(response[2]) << 8));
  if (responseCount > count) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_TransferBlock read response count " +
                             std::to_string(responseCount) + " exceeds requested " +
                             std::to_string(count) + "; response=" + hexDump(response));
  }
  const size_t minimumLength = 4 + static_cast<size_t>(responseCount) * 4;
  if (response.size() < minimumLength) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_TransferBlock read response length " +
                             std::to_string(response.size()) +
                             " is shorter than the declared " +
                             std::to_string(responseCount) +
                             " word(s) (truncated); response=" + hexDump(response));
  }
  // Strict status validation: reserved bits (4..7) and invalid ACK values
  // fail BEFORE any data is accepted, so unconfirmed values never reach the
  // caller. `values` stays empty on every error path.
  uint8_t ackLocal = 0;
  const Result statusResult = validateTransferStatus(response[3], true, ackLocal);
  if (!statusResult.ok) {
    values.clear();
    return Result::error(statusResult.errorCode,
                         "DAP_TransferBlock read " + statusResult.message + "; response=" +
                             hexDump(response));
  }
  ack = ackLocal;
  completed = responseCount;
  if (responseCount < count) {
    // Probe stopped after `completed` transfers with a non-OK status. The
    // caller decides whether WAIT/FAULT may be retried; NO_ACK never is.
    if (ack == kAckOk) {
      return Result::error(
          ErrorCodes::kMalformedResponse,
          "DAP_TransferBlock read completed " + std::to_string(completed) + " of " +
              std::to_string(count) + " transfers but reports ACK=OK; response=" +
              hexDump(response));
    }
    return Result::error(ackErrorCode(ack),
                         "DAP_TransferBlock read ACK=" + ackName(ack) + " completed=" +
                             std::to_string(completed) + "/" + std::to_string(count));
  }
  if (ack != kAckOk) {
    return Result::error(ackErrorCode(ack),
                         "DAP_TransferBlock read completed " + std::to_string(completed) +
                             " transfers with final status ACK=" + ackName(ack));
  }
  values.reserve(completed);
  for (size_t i = 0; i < completed; ++i) {
    values.push_back(readLe32(response, 4 + i * 4));
  }
  return Result::success();
}

Result CmsisDapProtocol::dapTransferBlockWrite(uint8_t dapIndex, uint8_t request,
                                               const std::vector<uint32_t>& values, uint8_t& ack,
                                               uint16_t& completed,
                                               std::chrono::milliseconds timeout) {
  ack = 0;
  completed = 0;
  if (values.empty() || values.size() > 0xFFFF) {
    return Result::error(ErrorCodes::kDapInvalidRequest,
                         "DAP_TransferBlock write requires 1..65535 words, got " +
                             std::to_string(values.size()));
  }
  const uint16_t count = static_cast<uint16_t>(values.size());
  // Official request: [0x06][DAP index][Count (16-bit LE)][Transfer Request]
  // [Write Data...].
  std::vector<uint8_t> command;
  command.reserve(5 + count * 4);
  command.push_back(kCmdTransferBlock);
  command.push_back(dapIndex);
  command.push_back(static_cast<uint8_t>(count & 0xFF));
  command.push_back(static_cast<uint8_t>((count >> 8) & 0xFF));
  command.push_back(request);
  for (const uint32_t value : values) {
    command.push_back(static_cast<uint8_t>(value & 0xFF));
    command.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    command.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
    command.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
  }
  const size_t capacity = payloadCapacity();
  if (capacity != 0 && command.size() > capacity) {
    return Result::error(ErrorCodes::kPacketTooLarge,
                         "DAP_TransferBlock write request of " +
                             std::to_string(command.size()) + " bytes exceeds packet capacity " +
                             std::to_string(capacity));
  }
  std::vector<uint8_t> response;
  const Result exchangeResult = exchange(command, kCmdTransferBlock, response, timeout);
  if (!exchangeResult.ok) {
    // A write that was already sent may have completed; never retry it. The
    // transport error is surfaced as-is (ReadTimeout/WriteCompletedLate/
    // DeviceRemoved/...), the caller must not resend.
    return Result::error(exchangeResult.errorCode,
                         "DAP_TransferBlock write failed (completion state unknown, not "
                         "retried): " +
                             exchangeResult.message);
  }
  // Official response: [0x06][Count (16-bit LE)][Transfer Response] - no data
  // for writes. Trailing bytes are HID report padding and are ignored; a
  // response shorter than 4 bytes is truncated and rejected.
  if (response.size() < 4) {
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_TransferBlock write response length " +
                             std::to_string(response.size()) +
                             " is shorter than expected 4 (completion state unknown, not "
                             "retried); response=" +
                             hexDump(response));
  }
  const uint16_t responseCount =
      static_cast<uint16_t>(response[1] | (static_cast<uint16_t>(response[2]) << 8));
  // Validate the status before interpreting a short count. An explicit
  // WAIT/FAULT says the probe rejected the next write, so the target layer
  // may perform its bounded recovery. A short count with ACK_OK (or any
  // malformed/reserved status) does not say what landed and stays a
  // non-retryable unknown-completion result.
  uint8_t ackLocal = 0;
  const Result statusResult = validateTransferStatus(response[3], true, ackLocal);
  if (!statusResult.ok) {
    return Result::error(statusResult.errorCode,
                         "DAP_TransferBlock write " + statusResult.message +
                         " (completion state unknown, not retried); response=" +
                             hexDump(response));
  }
  if (responseCount != count) {
    if (ackLocal == kAckWait || ackLocal == kAckFault) {
      ack = ackLocal;
      completed = responseCount;
      return Result::error(ackErrorCode(ackLocal),
                           "DAP_TransferBlock write ACK=" + ackName(ackLocal) +
                               " completed=" + std::to_string(responseCount) + "/" +
                               std::to_string(count));
    }
    return Result::error(ErrorCodes::kMalformedResponse,
                         "DAP_TransferBlock write response count " +
                             std::to_string(responseCount) + " does not match requested " +
                             std::to_string(count) +
                             " (completion state unknown, not retried); response=" +
                             hexDump(response));
  }
  ack = ackLocal;
  completed = responseCount;
  if (ack != kAckOk) {
    return Result::error(ackErrorCode(ack),
                         "DAP_TransferBlock write ACK=" + ackName(ack) + " completed=" +
                             std::to_string(completed) + "/" + std::to_string(count));
  }
  return Result::success();
}

size_t CmsisDapProtocol::payloadCapacity() const {
  return transport_ ? transport_->payloadCapacity() : 0;
}

uint16_t CmsisDapProtocol::effectivePacketSize() const { return effectivePacketSize_; }

void CmsisDapProtocol::setEffectivePacketSize(uint16_t packetSize) {
  effectivePacketSize_ = packetSize;
}

}  // namespace cmsis_dap_helper
