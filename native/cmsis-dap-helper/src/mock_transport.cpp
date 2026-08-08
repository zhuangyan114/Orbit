#include "mock_transport.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <optional>
#include <thread>

namespace cmsis_dap_helper {

namespace {

// SW-DP register offsets used by the simulated target.
constexpr uint8_t kDpAbortIdcode = 0x00;
constexpr uint8_t kDpCtrlStat = 0x04;
constexpr uint8_t kDpSelect = 0x08;
constexpr uint8_t kDpRdbuff = 0x0C;

// SW-DP CTRL/STAT sticky bits.
constexpr uint32_t kStickyOrun = 1u << 1;
constexpr uint32_t kStickyCmp = 1u << 4;
constexpr uint32_t kStickyErr = 1u << 5;
constexpr uint32_t kWdataErr = 1u << 7;

// MEM-AP bank-0 register offsets.
constexpr uint8_t kApCsw = 0x00;
constexpr uint8_t kApTar = 0x04;
constexpr uint8_t kApDrw = 0x0C;

uint32_t readLe32Value(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
}

void pushLe32(std::vector<uint8_t>& out, uint32_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
}

bool isDpidrPrimeTransfer(const uint8_t* data, size_t length) {
  return length == 4 && data[0] == kMockCmdTransfer && data[1] == 0x00 &&
         data[2] == 0x01 && data[3] == kMockReqRnw;
}

}  // namespace

MockCmsisDapTransport::MockCmsisDapTransport() {
  devices_.push_back(makeDevice("1234", "5678", "MOCK-0001", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5679", "MOCK-0002", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "567A", "MOCK-0003", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "567B", "MOCK-0004", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "567C", "MOCK-0005", 33, 33, 1));
  devices_.push_back(makeDevice("1234", "567D", "MOCK-0006", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "567E", "MOCK-0007", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "567F", "MOCK-0008", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5680", "MOCK-0009", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5681", "MOCK-0010", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5682", "MOCK-0011", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5683", "MOCK-0012", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5684", "MOCK-0013", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5685", "MOCK-0014", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5686", "MOCK-0015", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5687", "MOCK-0016", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5688", "MOCK-0017", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "5689", "MOCK-0018", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "568A", "MOCK-0019", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "568B", "MOCK-0020", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "568C", "MOCK-0021", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "568D", "MOCK-0022", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "568E", "MOCK-0023", 65, 65, 0));
  devices_.push_back(makeDevice("1234", "568F", "MOCK-0024", 65, 65, 0));
}

DeviceDescriptor MockCmsisDapTransport::makeDevice(const std::string& vid, const std::string& pid,
                                                   const std::string& serial,
                                                   uint16_t inputReportLength,
                                                   uint16_t outputReportLength,
                                                   uint8_t reportId) {
  DeviceDescriptor device;
  device.vid = vid;
  device.pid = pid;
  device.manufacturer = "MockVendor";
  device.product = "Mock CMSIS-DAP";
  device.serial = serial;
  device.path = "MOCK\\" + vid + "#" + pid + "#" + serial;
  device.inputReportLength = inputReportLength;
  device.outputReportLength = outputReportLength;
  device.reportId = reportId;
  device.usagePage = 0xFF00;
  device.usage = 0x0001;
  device.transport = "mock";
  return device;
}

std::vector<uint8_t> MockCmsisDapTransport::stringPayload(const std::string& value) {
  // Official layout: strings are NUL-terminated and the length includes the NUL.
  std::vector<uint8_t> payload(value.begin(), value.end());
  payload.push_back(0);
  return payload;
}

std::string MockCmsisDapTransport::behaviorKey(const DeviceDescriptor& device) {
  return device.vid + ":" + device.pid;
}

Result MockCmsisDapTransport::enumerate(const DeviceSelector& selector,
                                        std::vector<DeviceDescriptor>& out) {
  out.clear();
  for (const DeviceDescriptor& device : devices_) {
    if (!selector.path.empty()) {
      if (selector.path != device.path) continue;
    } else {
      if (!selector.vid.empty() && selector.vid != device.vid) continue;
      if (!selector.pid.empty() && selector.pid != device.pid) continue;
      if (!selector.serial.empty() && selector.serial != device.serial) continue;
      if (!selector.product.empty() && selector.product != device.product) continue;
    }
    out.push_back(device);
  }
  return Result::success();
}

Result MockCmsisDapTransport::open(const DeviceDescriptor& device) {
  if (opened_) {
    return Result::error(ErrorCodes::kInvalidState, "mock device is already open");
  }
  for (const DeviceDescriptor& candidate : devices_) {
    if (candidate.path == device.path) {
      selected_ = candidate;
      opened_ = true;
      lost_ = false;
      pending_.clear();
      state_ = MockSwdState{};
      state_.ram.assign(kMockRamSize, 0);
      state_.flash.assign(kMockFlashSize, 0);
      for (uint32_t i = 0; i < kMockRamSize; ++i) state_.ram[i] = mockByteAt(kMockRamBase + i);
      for (uint32_t i = 0; i < kMockFlashSize; ++i) state_.flash[i] = mockByteAt(kMockFlashBase + i);
      const uint32_t vectorWords[] = {
          kMockFlashVectorWord0, kMockFlashVectorWord1,
          kMockFlashVectorWord2, kMockFlashVectorWord3};
      std::memcpy(state_.flash.data(), vectorWords, sizeof(vectorWords));
      // DAP-05 source-step fixture: NOP; BL 0x080001E0; return at 0x080001C6.
      const uint8_t sourceStepFixture[] = {
          0x00, 0xBF,                    // 0x080001C0 NOP
          0x00, 0xF0, 0x0D, 0xF8,        // 0x080001C2 BL 0x080001E0
          0x00, 0xBF,                    // 0x080001C6 NOP
          0x00, 0xD0,                    // 0x080001C8 BEQ (not taken; Z=0)
          0xFE, 0xE7,                    // 0x080001CA B 0x080001CA
      };
      std::memcpy(state_.flash.data() + (kMockResetPc - kMockFlashBase),
                  sourceStepFixture, sizeof(sourceStepFixture));
      const uint8_t calleeFixture[] = {0x00, 0xBF, 0x70, 0x47};
      std::memcpy(state_.flash.data() + (0x080001E0u - kMockFlashBase),
                  calleeFixture, sizeof(calleeFixture));
      state_.dhcsr = kMockCoreDebugCDebugEn;
      state_.dcrsr = 0;
      state_.dcrdr = 0;
      state_.aircr = 0;
      state_.lastDhcsrWrite = 0;
      state_.lastAircrWrite = 0;
      state_.registers.fill(0);
      for (uint32_t i = 0; i <= 12; ++i) state_.registers[i] = 0x10000000u + i;
      state_.registers[13] = 0x20001000u;
      state_.registers[14] = 0x08001001u;
      state_.registers[15] = kMockResetPc;
      state_.registers[16] = 0x01000000u;
      state_.registers[17] = state_.registers[13];
      state_.registers[18] = state_.registers[13];
      injection_ = MockInjection{};
      commandHistory_.clear();
      const std::string key = behaviorKey(candidate);
      if (key == "1234:567F") injection_.waitBudget = 2;
      if (key == "1234:5680") {
        injection_.faultOnFirst = true;
        injection_.stickyBlocks = true;
      }
      if (key == "1234:5681") injection_.noAck = true;
      if (key == "1234:5682") injection_.malformedTransfer = true;
      if (key == "1234:5683") injection_.alwaysWait = true;
      if (key == "1234:5684") injection_.writeUnknown = true;
      if (key == "1234:5685") injection_.removedOnTransfer = true;
      if (key == "1234:5686") injection_.controlStuck = true;
      if (key == "1234:5687") injection_.flashBusy = true;
      if (key == "1234:5688") injection_.flashProtected = true;
      if (key == "1234:5689") injection_.verifyCorruption = true;
      if (key == "1234:568A") injection_.flashRemoved = true;
      if (key == "1234:568B") injection_.flashAlgorithmStuck = true;
      if (key == "1234:568C") injection_.fpbNeverHits = true;
      if (key == "1234:568D") {
        injection_.stepDhcsrLagReads = 8;
        injection_.fpbHitsCurrentPc = true;
      }
      if (key == "1234:568E") {
        injection_.interruptOnUnmaskedStep = true;
        injection_.interruptOnUnmaskedAlgorithmStart = true;
      }
      if (key == "1234:568F") injection_.resetRunsPastStartupEntry = true;
      preparedFlashAlgorithm_ = MockFlashAlgorithmRequest{};
      ioCounters_ = TransportIoCounters{};
      return Result::success();
    }
  }
  return Result::error(ErrorCodes::kDeviceNotFound, "mock device is not in the built-in table");
}

Result MockCmsisDapTransport::close() {
  opened_ = false;
  lost_ = false;
  pending_.clear();
  return Result::success();
}

Result MockCmsisDapTransport::writePacket(const uint8_t* data, size_t length,
                                          std::chrono::milliseconds /*timeout*/) {
  if (!opened_) {
    return Result::error(ErrorCodes::kInvalidState, "mock device is not open");
  }
  ++ioCounters_.writeReports;
  ioCounters_.writePayloadBytes += length;
  ioCounters_.writeReportBytes += selected_.outputReportLength;
  const std::string key = behaviorKey(selected_);
  if (injection_.removedOnTransfer && !injection_.removalConsumed && length > 0 &&
      data[0] == kMockCmdTransfer && !isDpidrPrimeTransfer(data, length)) {
    // The device disappears in the middle of a transfer: the command that
    // caused the removal never gets a response.
    injection_.removalConsumed = true;
    lost_ = true;
    return Result::error(ErrorCodes::kDeviceRemoved,
                         "mock device was removed during DAP_Transfer");
  }
  if (lost_) {
    return Result::error(ErrorCodes::kDeviceRemoved, "mock device was removed");
  }
  if (length == 0) {
    // CMSIS-DAP v1 empty output report: "no command pending", ignored.
    return Result::success();
  }
  commandHistory_.push_back(data[0]);
  if (key == "1234:567B") {
    // silent device: never enqueue a response.
    return Result::success();
  }
  std::vector<uint8_t> response;
  switch (data[0]) {
    case kMockCmdInfo:
      response = dapInfoResponse(data, length, key);
      break;
    case kMockCmdConnect:
      response = dapConnectResponse(data, length, key);
      break;
    case kMockCmdDisconnect:
      response = dapDisconnectResponse(key);
      break;
    case kMockCmdTransferConfigure:
      response = {kMockCmdTransferConfigure};
      break;
    case kMockCmdResetTarget:
      response = {kMockCmdResetTarget, 0x00};
      break;
    case kMockCmdSwjPins:
      response = {kMockCmdSwjPins, 0x80};
      break;
    case kMockCmdSwjClock:
      response = {kMockCmdSwjClock, 0x00};
      break;
    case kMockCmdSwjSequence:
      response = {kMockCmdSwjSequence, 0x00};
      break;
    case kMockCmdSwdConfigure:
      response = {kMockCmdSwdConfigure, 0x00};
      break;
    case kMockCmdTransfer:
      injection_.transferCount++;
      lastTransferRequest_.assign(data, data + length);
      response = processTransfer(data, length, key);
      break;
    case kMockCmdTransferBlock:
      if (length >= 5 && (data[4] & kMockReqRnw) == 0) injection_.blockWriteCount++;
      else if (length >= 5) injection_.blockReadCount++;
      lastBlockRequest_.assign(data, data + length);
      response = processTransferBlock(data, length, key);
      break;
    case kMockCmdWriteAbort:
      if (length != 6 || data[1] != 0) {
        response = {kMockCmdWriteAbort, 0xFF};
      } else {
        // DAP_WriteABORT carries the same DP ABORT W1C semantics as a direct
        // SW-DP write, but uses its dedicated CMSIS-DAP wire command.
        const TransferOutcome outcome =
            accessDp(kDpAbortIdcode, false, readLe32Value(data + 2));
        response = {kMockCmdWriteAbort,
                    outcome.ack == kMockAckOk ? static_cast<uint8_t>(0x00)
                                              : static_cast<uint8_t>(0xFF)};
      }
      break;
    default:
      // Unknown command: echo a response whose command id can never match.
      response.push_back(0xFF);
      break;
  }
  pending_.push_back(std::move(response));
  return Result::success();
}

Result MockCmsisDapTransport::readPacket(uint8_t* data, size_t capacity, size_t& length,
                                         std::chrono::milliseconds timeout) {
  length = 0;
  if (!opened_) {
    return Result::error(ErrorCodes::kInvalidState, "mock device is not open");
  }
  ++ioCounters_.readReports;
  if (lost_) {
    return Result::error(ErrorCodes::kDeviceRemoved, "mock device was removed");
  }
  if (pending_.empty()) {
    // No response available (silent device or protocol misuse): emulate the
    // device never answering by waiting out the caller's timeout.
    std::this_thread::sleep_for(timeout);
    return Result::error(ErrorCodes::kReadTimeout,
                         "mock device did not respond within " + std::to_string(timeout.count()) +
                             " ms");
  }
  const std::vector<uint8_t>& response = pending_.front();
  if (response.size() > capacity) {
    return Result::error(ErrorCodes::kMalformedResponse, "mock response exceeds caller capacity");
  }
  if (!response.empty()) std::memcpy(data, response.data(), response.size());
  length = response.size();
  ioCounters_.readPayloadBytes += response.size();
  ioCounters_.readReportBytes += selected_.inputReportLength;
  pending_.pop_front();
  return Result::success();
}

Result MockCmsisDapTransport::drainInput(std::chrono::milliseconds /*timeout*/) {
  pending_.clear();
  return Result::success();
}

std::vector<uint8_t> MockCmsisDapTransport::dapInfoResponse(const uint8_t* data, size_t length,
                                                            const std::string& key) const {
  const uint8_t infoId = length >= 2 ? data[1] : 0;
  std::vector<uint8_t> payload;
  if (key != "1234:5679") {  // empty-info device returns len=0 for everything
    switch (infoId) {
      case 0x01: payload = stringPayload("MockVendor"); break;
      case 0x02: payload = stringPayload("Mock CMSIS-DAP"); break;
      case 0x03: payload = stringPayload(selected_.serial); break;
      case 0x04: payload = stringPayload("1.0"); break;
      case 0x09: payload = stringPayload("1.2.3"); break;
      case 0xF0: payload = {0x01}; break;   // Capabilities: Bit0 = SWD
      case 0xFE: payload = {0x01}; break;   // Packet Count: BYTE = 1
      case 0xFF: payload = {0x40, 0x00}; break;  // Packet Size: SHORT LE = 64
      default: break;  // unknown info id: len=0 (official "no information")
    }
  }
  std::vector<uint8_t> response;
  if (key == "1234:567A" && infoId == 0xFF) {
    // Corrupt device: reply with command byte 0xFF (official "command not
    // implemented" reply) instead of 0x00, so the command id check fails.
    response.push_back(0xFF);
    response.push_back(static_cast<uint8_t>(payload.size()));
    response.insert(response.end(), payload.begin(), payload.end());
    return response;
  }
  response.push_back(kMockCmdInfo);
  if (key == "1234:567D") {
    // vendor-echo legacy layout: [cmd][infoId][len][data]. Not exercised by
    // the smoke suite; kept only for future compatibility checks.
    response.push_back(infoId);
  }
  response.push_back(static_cast<uint8_t>(payload.size()));
  response.insert(response.end(), payload.begin(), payload.end());
  return response;
}

std::vector<uint8_t> MockCmsisDapTransport::dapConnectResponse(const uint8_t* data, size_t length,
                                                               const std::string& key) const {
  if (key == "1234:567A") {
    // Corrupt device: invalid port byte 0xFF (official ports are 0/1/2).
    return {kMockCmdConnect, 0xFF};
  }
  const uint8_t port = length >= 2 && data[1] == 2 ? 2 : 1;  // 1=SWD, 2=JTAG
  if (key == "1234:567E") {
    // connect-fail device: port 0 = initialization failed (official).
    return {kMockCmdConnect, 0x00};
  }
  if (key == "1234:567D") {
    // vendor-echo legacy layout: [cmd][status][port]. Not exercised by the
    // smoke suite; kept only for future compatibility checks.
    return {kMockCmdConnect, 0x00, port};
  }
  return {kMockCmdConnect, port};
}

std::vector<uint8_t> MockCmsisDapTransport::dapDisconnectResponse(const std::string& key) const {
  if (key == "1234:567A") {
    // Corrupt device: DAP_Disconnect returns DAP_ERROR status (0xFF).
    return {kMockCmdDisconnect, 0xFF};
  }
  return {kMockCmdDisconnect, 0x00};
}

uint32_t MockCmsisDapTransport::autoIncrementTar(uint32_t tar) {
  // MEM-AP TAR auto-increment wraps the low 10 bits at the 1 KiB boundary.
  return (tar & ~0x3FFu) | ((tar + 4) & 0x3FFu);
}

bool MockCmsisDapTransport::cswShapeOk(uint32_t csw) {
  // ADIv5/MEM-AP CSW shape required for DRW accesses:
  //   - Size   bits[2:0]  == 0b010 (32-bit). Every other Size encoding is
  //     rejected: 0b000 (8-bit), 0b001 (16-bit), 0b011 (64-bit, not
  //     supported by the verified target), 0b100 (128-bit) and the reserved
  //     values 0b101/0b110/0b111. DeviceEn is bit6, outside this check; the
  //     verified target keeps it asserted on its own.
  //   - AddrInc bits[5:4] == 0b01  (single); off/packed rejected
  // Examples rejected here: 0x95 and 0x02000095 both carry the reserved Size
  // encoding 0b101 in bits[2:0] (which the STM32F407 AHB-AP reads back as
  // 0b001, i.e. 16-bit accesses with stale upper halves); 0x13 carries
  // Size=0b011 which the verified target does not support. Rejecting them at
  // the mock keeps a wrong-size CSW from silently producing halfword-lane
  // reads with stale upper halves.
  if ((csw & 0x07u) != 0x02u) return false;
  if ((csw & 0x30u) != 0x10u) return false;
  return true;
}

uint32_t MockCmsisDapTransport::readMemWord(uint32_t address) {
  if (address == kMockCoreDebugDhcsr) {
    const uint32_t value = state_.dhcsr;
    state_.dhcsr &= ~kMockCoreDebugSRetireSt;
    if (state_.pendingStepDhcsrReads > 0 && --state_.pendingStepDhcsrReads == 0) {
      const uint32_t pendingWrite = state_.pendingStepDhcsrWrite;
      state_.pendingStepDhcsrWrite = 0;
      const uint32_t lagReads = injection_.stepDhcsrLagReads;
      injection_.stepDhcsrLagReads = 0;
      writeMemWord(kMockCoreDebugDhcsr, pendingWrite);
      injection_.stepDhcsrLagReads = lagReads;
    }
    return value;
  }
  if (address == kMockCoreDebugDcrsr) return state_.dcrsr;
  if (address == kMockCoreDebugDcrdr) return state_.dcrdr;
  if (address == kMockCoreDebugAircr) return state_.aircr;
  if (address == kMockFpbCtrl) return state_.fpCtrl;
  if (address >= kMockFpbComp0 && address < kMockFpbComp0 + kMockFpbCodeComparators * 4u
      && (address & 3u) == 0) {
    return state_.fpComp[(address - kMockFpbComp0) / 4u];
  }
  if (address == 0xE0042000u) return 0x10006413u;
  if (address == 0x1FFF7A20u) return 0x00020000u;
  const uint8_t* base = nullptr;
  if (address >= kMockRamBase && address + 4 <= kMockRamBase + kMockRamSize) {
    base = state_.ram.data() + (address - kMockRamBase);
  } else if (address >= kMockFlashBase && address + 4 <= kMockFlashBase + kMockFlashSize) {
    base = state_.flash.data() + (address - kMockFlashBase);
  } else {
    // Unmapped memory reads as zero (documented mock behavior).
    return 0;
  }
  return static_cast<uint32_t>(base[0]) | (static_cast<uint32_t>(base[1]) << 8) |
         (static_cast<uint32_t>(base[2]) << 16) | (static_cast<uint32_t>(base[3]) << 24);
}

void MockCmsisDapTransport::writeMemWord(uint32_t address, uint32_t value) {
  if (address == kMockCoreDebugDhcsr) {
    state_.lastDhcsrWrite = value;
    if ((value & 0xFFFF0000u) != kMockCoreDebugDbgKey) return;
    if (injection_.controlStuck) return;
    const bool debugEnabled = (value & kMockCoreDebugCDebugEn) != 0;
    const bool wasHalted = (state_.dhcsr & kMockCoreDebugSHalt) != 0;
    const bool step = (value & kMockCoreDebugCStep) != 0;
    const bool halt = (value & kMockCoreDebugCHalt) != 0;
    const bool maskInterrupts = (value & kMockCoreDebugCMaskInts) != 0;
    if (step && injection_.stepDhcsrLagReads > 0 && state_.pendingStepDhcsrReads == 0) {
      state_.pendingStepDhcsrReads = injection_.stepDhcsrLagReads;
      state_.pendingStepDhcsrWrite = value;
      return;
    }
    if (!step) {
      state_.pendingStepDhcsrReads = 0;
      state_.pendingStepDhcsrWrite = 0;
    }
    if (preparedFlashAlgorithm_.pending && debugEnabled && !halt && !step) {
      injection_.algorithmInterruptMaskAtEntry = maskInterrupts;
      if (injection_.interruptOnUnmaskedAlgorithmStart && !maskInterrupts) {
        preparedFlashAlgorithm_.pending = false;
        ++injection_.flashAlgorithmCount;
        state_.dhcsr = kMockCoreDebugCDebugEn;
        return;
      }
      if (preparedFlashAlgorithm_.ramStub) {
        runPreparedRamStub();
        return;
      }
      runPreparedFlashAlgorithm();
      return;
    }
    state_.dhcsr = debugEnabled
                       ? kMockCoreDebugCDebugEn |
                             (maskInterrupts ? kMockCoreDebugCMaskInts : 0u)
                       : 0;
    if (halt || step || (wasHalted && !debugEnabled)) {
      state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady |
                      kMockCoreDebugSRetireSt;
    }
    if (step) {
      const uint32_t pc = state_.registers[15];
      if (injection_.interruptOnUnmaskedStep && !maskInterrupts) {
        state_.stepInterrupted = true;
        state_.interruptedStepPc = pc;
        state_.registers[15] = 0x080043B4u;
        state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
        return;
      }
      const uint32_t offset = pc - kMockFlashBase;
      const uint16_t hw1 = static_cast<uint16_t>(state_.flash[offset]) |
                           (static_cast<uint16_t>(state_.flash[offset + 1]) << 8);
      const uint16_t hw2 = static_cast<uint16_t>(state_.flash[offset + 2]) |
                           (static_cast<uint16_t>(state_.flash[offset + 3]) << 8);
      const bool isBl = (hw1 & 0xF800u) == 0xF000u && (hw2 & 0xD000u) == 0xD000u;
      const bool isBlxReg = (hw1 & 0xFF87u) == 0x4780u;
      const bool isConditionalBranch = (hw1 & 0xF000u) == 0xD000u
                                    && ((hw1 >> 8) & 0x0Fu) < 0x0Eu;
      const bool isUnconditionalBranch = (hw1 & 0xF800u) == 0xE000u;
      if (isBl) {
        const uint32_t s = (hw1 >> 10) & 1u;
        const uint32_t j1 = (hw2 >> 13) & 1u;
        const uint32_t j2 = (hw2 >> 11) & 1u;
        const uint32_t i1 = (~(j1 ^ s)) & 1u;
        const uint32_t i2 = (~(j2 ^ s)) & 1u;
        uint32_t immediate = (s << 24) | (i1 << 23) | (i2 << 22)
                           | ((hw1 & 0x03FFu) << 12) | ((hw2 & 0x07FFu) << 1);
        if ((immediate & 0x01000000u) != 0) immediate |= 0xFE000000u;
        state_.registers[14] = (pc + 4u) | 1u;
        state_.registers[15] = (pc + 4u + immediate) & ~1u;
      } else if (isBlxReg) {
        const uint32_t rm = (hw1 >> 3) & 0x0Fu;
        state_.registers[14] = (pc + 2u) | 1u;
        state_.registers[15] = state_.registers[rm] & ~1u;
      } else if (isConditionalBranch) {
        const uint32_t condition = (hw1 >> 8) & 0x0Fu;
        const bool n = (state_.registers[16] & (1u << 31)) != 0;
        const bool z = (state_.registers[16] & (1u << 30)) != 0;
        const bool c = (state_.registers[16] & (1u << 29)) != 0;
        const bool v = (state_.registers[16] & (1u << 28)) != 0;
        const bool baseConditions[] = {z, c, n, v, c && !z, n == v, !z && n == v};
        const bool base = baseConditions[condition >> 1];
        const bool taken = (condition & 1u) == 0 ? base : !base;
        int32_t immediate = static_cast<int32_t>((hw1 & 0xFFu) << 1);
        if ((immediate & 0x100) != 0) immediate |= ~0x1FF;
        state_.registers[15] = taken
            ? static_cast<uint32_t>(static_cast<int32_t>(pc + 4u) + immediate)
            : pc + 2u;
      } else if (isUnconditionalBranch) {
        int32_t immediate = static_cast<int32_t>((hw1 & 0x07FFu) << 1);
        if ((immediate & 0x800) != 0) immediate |= ~0x0FFF;
        state_.registers[15] = static_cast<uint32_t>(static_cast<int32_t>(pc + 4u) + immediate);
      } else {
        const bool is32Bit = (hw1 & 0xF800u) == 0xE800u
                          || (hw1 & 0xF800u) == 0xF000u
                          || (hw1 & 0xF800u) == 0xF800u;
        state_.registers[15] += is32Bit ? 4u : 2u;
      }
      state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
    } else if (debugEnabled && !halt) {
      // Independent FPB hit oracle: running selects the nearest enabled code
      // comparator other than the current PC and reports a halted target.
      const uint32_t currentPc = state_.registers[15];
      std::optional<uint32_t> forward;
      std::optional<uint32_t> fallback;
      if (state_.stepInterrupted) {
        for (uint32_t comparator : state_.fpComp) {
          if ((comparator & 1u) == 0) continue;
          const uint32_t replace = comparator >> 30;
          if (replace != 1u && replace != 2u) continue;
          const uint32_t hitAddress =
              (comparator & 0x1FFFFFFCu) + (replace == 2u ? 2u : 0u);
          if (hitAddress == state_.interruptedStepPc) {
            state_.registers[15] = hitAddress;
            state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
            state_.stepInterrupted = false;
            return;
          }
        }
      }
      if (!injection_.fpbNeverHits && (state_.fpCtrl & 1u) != 0) {
        for (uint32_t comparator : state_.fpComp) {
          if ((comparator & 1u) == 0) continue;
          const uint32_t replace = comparator >> 30;
          if (replace != 1u && replace != 2u) continue;
          const uint32_t hitAddress = (comparator & 0x1FFFFFFCu) + (replace == 2u ? 2u : 0u);
          if (hitAddress == currentPc && !injection_.fpbHitsCurrentPc) continue;
          if (hitAddress == (state_.registers[14] & ~1u)
              && (!fallback || hitAddress < *fallback)) fallback = hitAddress;
          if (hitAddress > currentPc && (!forward || hitAddress < *forward)) forward = hitAddress;
        }
      }
      const std::optional<uint32_t> hit = forward ? forward : fallback;
      if (hit) {
        state_.registers[15] = *hit;
        state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
      }
    }
    return;
  }
  if (address == kMockCoreDebugDcrsr) {
    state_.dcrsr = value;
    const uint32_t index = value & 0x1Fu;
    const bool write = (value & kMockCoreDebugRegWrite) != 0;
    state_.dhcsr &= ~kMockCoreDebugSRegReady;
    if ((state_.dhcsr & kMockCoreDebugSHalt) != 0 && index < state_.registers.size()) {
      if (write) {
        state_.registers[index] = state_.dcrdr;
      } else {
        state_.dcrdr = index == 15 ? state_.registers[15] : state_.registers[index];
      }
      state_.dhcsr |= kMockCoreDebugSRegReady;
    }
    return;
  }
  if (address == kMockCoreDebugDcrdr) {
    state_.dcrdr = value;
    return;
  }
  if (address == kMockCoreDebugAircr) {
    state_.lastAircrWrite = value;
    state_.aircr = value;
    if (injection_.controlStuck) return;
    if ((value & 0xFFFF0000u) == kMockCoreDebugVectKey &&
        (value & kMockCoreDebugSysResetReq) != 0) {
      if (injection_.resetRunsPastStartupEntry) {
        state_.registers[15] = kMockPostStartupPc;
        state_.dhcsr = kMockCoreDebugCDebugEn;
        if ((state_.fpCtrl & 1u) != 0) {
          for (uint32_t comparator : state_.fpComp) {
            if ((comparator & 1u) == 0) continue;
            const uint32_t replace = comparator >> 30;
            if (replace != 1u && replace != 2u) continue;
            const uint32_t hitAddress =
                (comparator & 0x1FFFFFFCu) + (replace == 2u ? 2u : 0u);
            if (hitAddress == kMockStartupEntryPc) {
              state_.registers[15] = hitAddress;
              state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
              break;
            }
          }
        }
        return;
      }
      const bool wasHalted = (state_.dhcsr & kMockCoreDebugSHalt) != 0;
      state_.registers[15] = kMockResetPc;
      state_.dhcsr = kMockCoreDebugCDebugEn;
      if (wasHalted) state_.dhcsr |= kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
    }
    return;
  }
  if (address == kMockFpbCtrl) {
    // KEY is write-only; revision/count fields are read-only.
    state_.fpCtrl = (state_.fpCtrl & ~1u) | (value & 1u);
    return;
  }
  if (address >= kMockFpbComp0 && address < kMockFpbComp0 + kMockFpbCodeComparators * 4u
      && (address & 3u) == 0) {
    state_.fpComp[(address - kMockFpbComp0) / 4u] = value;
    return;
  }
  uint8_t* base = nullptr;
  bool isFlash = false;
  if (address >= kMockRamBase && address + 4 <= kMockRamBase + kMockRamSize) {
    base = state_.ram.data() + (address - kMockRamBase);
  } else if (address >= kMockFlashBase && address + 4 <= kMockFlashBase + kMockFlashSize) {
    base = state_.flash.data() + (address - kMockFlashBase);
    isFlash = true;
  } else {
    return;  // writes to unmapped memory are dropped
  }
  const uint8_t bytes[4] = {
      static_cast<uint8_t>(value & 0xFF), static_cast<uint8_t>((value >> 8) & 0xFF),
      static_cast<uint8_t>((value >> 16) & 0xFF), static_cast<uint8_t>((value >> 24) & 0xFF)};
  for (int index = 0; index < 4; ++index) {
    base[index] = isFlash ? static_cast<uint8_t>(base[index] & bytes[index]) : bytes[index];
  }
}

void MockCmsisDapTransport::prepareExceptionReturn(uint32_t handlerPc,
                                                   uint32_t excReturn,
                                                   uint32_t frameSp,
                                                   uint32_t stackedPc) {
  state_.registers[15] = handlerPc;
  state_.registers[14] = excReturn;
  state_.registers[(excReturn & 4u) != 0 ? 18u : 17u] = frameSp;
  state_.registers[13] = frameSp;
  state_.dhcsr = kMockCoreDebugCDebugEn | kMockCoreDebugSHalt |
                 kMockCoreDebugSRegReady;
  const uint32_t pcOffset = (excReturn & 0x10u) != 0 ? 24u : 96u;
  const uint32_t address = frameSp + pcOffset;
  if (address < kMockRamBase || address + 4u > kMockRamBase + state_.ram.size()) return;
  const size_t offset = address - kMockRamBase;
  state_.ram[offset] = static_cast<uint8_t>(stackedPc & 0xFFu);
  state_.ram[offset + 1] = static_cast<uint8_t>((stackedPc >> 8) & 0xFFu);
  state_.ram[offset + 2] = static_cast<uint8_t>((stackedPc >> 16) & 0xFFu);
  state_.ram[offset + 3] = static_cast<uint8_t>((stackedPc >> 24) & 0xFFu);
}

void MockCmsisDapTransport::prepareSourceInstruction(
    uint32_t pc, const std::vector<uint8_t>& bytes) {
  if (pc < kMockFlashBase || bytes.size() > kMockFlashBase + state_.flash.size() - pc) return;
  std::copy(bytes.begin(), bytes.end(), state_.flash.begin() + (pc - kMockFlashBase));
  state_.registers[15] = pc;
  state_.dhcsr = kMockCoreDebugCDebugEn | kMockCoreDebugSHalt |
                 kMockCoreDebugSRegReady;
}

void MockCmsisDapTransport::prepareFlashAlgorithm(const std::string& operation, uint32_t address,
                                                  uint32_t size, const std::vector<uint8_t>& data,
                                                  uint32_t bkptAddress) {
  state_.registers[16] = 0;
  preparedFlashAlgorithm_.pending = true;
  preparedFlashAlgorithm_.ramStub = false;
  preparedFlashAlgorithm_.operation = operation;
  preparedFlashAlgorithm_.address = address;
  preparedFlashAlgorithm_.size = size;
  preparedFlashAlgorithm_.data = data;
  preparedFlashAlgorithm_.bkptAddress = bkptAddress;
}

void MockCmsisDapTransport::prepareRamStub(uint32_t entry, uint32_t bkptAddress) {
  state_.registers[16] = 0;
  preparedFlashAlgorithm_ = MockFlashAlgorithmRequest{};
  preparedFlashAlgorithm_.pending = true;
  preparedFlashAlgorithm_.ramStub = true;
  preparedFlashAlgorithm_.operation = "ramStub";
  preparedFlashAlgorithm_.address = entry;
  preparedFlashAlgorithm_.bkptAddress = bkptAddress;
}

void MockCmsisDapTransport::runPreparedRamStub() {
  const uint32_t entry = preparedFlashAlgorithm_.address;
  const uint32_t bkpt = preparedFlashAlgorithm_.bkptAddress;
  preparedFlashAlgorithm_.pending = false;
  injection_.flashAlgorithmCount++;
  injection_.algorithmR0AtEntry = state_.registers[0];
  injection_.algorithmR1AtEntry = state_.registers[1];
  injection_.algorithmR2AtEntry = state_.registers[2];
  injection_.algorithmR3AtEntry = state_.registers[3];
  injection_.algorithmR9AtEntry = state_.registers[9];
  injection_.algorithmSpAtEntry = state_.registers[13];
  injection_.algorithmLrAtEntry = state_.registers[14];
  injection_.algorithmPcAtEntry = state_.registers[15];
  injection_.algorithmXpsrAtEntry = state_.registers[16];

  const uint32_t entryOffset = entry - kMockRamBase;
  const bool bxLr = entry >= kMockRamBase && entryOffset + 1u < state_.ram.size() &&
                    state_.ram[entryOffset] == 0x47 && state_.ram[entryOffset + 1u] == 0x70;
  const uint32_t bkptOffset = bkpt - kMockRamBase;
  const bool bkptInstruction = bkpt >= kMockRamBase && bkptOffset + 1u < state_.ram.size() &&
                               state_.ram[bkptOffset] == 0x00 && state_.ram[bkptOffset + 1u] == 0xBE;
  const bool thumbEntry = (state_.registers[15] & 1u) != 0;
  const bool thumbReturn = (state_.registers[14] & 1u) != 0;
  if (!bxLr || !bkptInstruction || !thumbEntry || !thumbReturn) return;

  // Model the two instructions used by this isolation fixture: BX LR clears
  // bit0 for the fetch address, then BKPT halts at the trusted sentinel.
  state_.registers[15] = state_.registers[14] & ~1u;
  state_.registers[15] = bkpt;
  state_.dhcsr = kMockCoreDebugCDebugEn | kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
}

void MockCmsisDapTransport::runPreparedFlashAlgorithm() {
  const std::string operation = preparedFlashAlgorithm_.operation;
  const uint32_t address = preparedFlashAlgorithm_.address;
  const uint32_t size = preparedFlashAlgorithm_.size;
  const auto data = preparedFlashAlgorithm_.data;
  const uint32_t bkpt = preparedFlashAlgorithm_.bkptAddress;
  preparedFlashAlgorithm_.pending = false;
  injection_.flashAlgorithmCount++;
  injection_.algorithmR0AtEntry = state_.registers[0];
  injection_.algorithmR1AtEntry = state_.registers[1];
  injection_.algorithmR2AtEntry = state_.registers[2];
  injection_.algorithmR3AtEntry = state_.registers[3];
  injection_.algorithmR9AtEntry = state_.registers[9];
  injection_.algorithmSpAtEntry = state_.registers[13];
  injection_.algorithmLrAtEntry = state_.registers[14];
  injection_.algorithmPcAtEntry = state_.registers[15];
  injection_.algorithmXpsrAtEntry = state_.registers[16];
  if (injection_.flashAlgorithmStuck) {
    state_.dhcsr = kMockCoreDebugCDebugEn;
    return;
  }
  uint32_t returnCode = 0;
  if (injection_.flashRemoved) {
    lost_ = true;
    return;
  }
  if (injection_.flashBusy) {
    returnCode = 1;
  } else if (injection_.flashProtected && operation != "init" && operation != "uninit") {
    returnCode = 2;
  } else if (operation == "eraseSector") {
    injection_.flashEraseCount++;
    if (address < kMockFlashBase || address + size > kMockFlashBase + kMockFlashSize || size == 0) {
      returnCode = 3;
    } else {
      std::fill(state_.flash.begin() + (address - kMockFlashBase),
                state_.flash.begin() + (address - kMockFlashBase) + size,
                static_cast<uint8_t>(0xFF));
    }
  } else if (operation == "programPage") {
    injection_.flashProgramCount++;
    if (address < kMockFlashBase || address + size > kMockFlashBase + kMockFlashSize || data.size() < size) {
      returnCode = 3;
    } else {
      for (uint32_t index = 0; index < size; ++index) {
        const uint8_t oldValue = state_.flash[address - kMockFlashBase + index];
        const uint8_t newValue = data[index];
        if ((oldValue & newValue) != newValue) {
          returnCode = 4;  // programming can only change 1 -> 0
          break;
        }
      }
      if (returnCode == 0) {
        for (uint32_t index = 0; index < size; ++index) {
          state_.flash[address - kMockFlashBase + index] &= data[index];
        }
        if (injection_.verifyCorruption && size > 0) {
          state_.flash[address - kMockFlashBase] |= 0x01u;
          injection_.verifyCorruption = false;
        }
      }
    }
  } else if (operation == "verify") {
    injection_.flashVerifyCount++;
    if (address < kMockFlashBase || address + size > kMockFlashBase + kMockFlashSize || data.size() < size) {
      returnCode = 3;
    } else {
      for (uint32_t index = 0; index < size; ++index) {
        if (state_.flash[address - kMockFlashBase + index] != data[index]) {
          returnCode = 5;
          break;
        }
      }
    }
  }
  state_.registers[0] = returnCode;
  state_.registers[15] = bkpt;
  state_.dhcsr = kMockCoreDebugCDebugEn | kMockCoreDebugSHalt | kMockCoreDebugSRegReady;
}

MockCmsisDapTransport::TransferOutcome MockCmsisDapTransport::accessDp(uint8_t regAddr, bool rnw,
                                                                       uint32_t value) {
  if (rnw) {
    switch (regAddr) {
      case kDpAbortIdcode: return {kMockAckOk, state_.dpIdcode, true};
      case kDpCtrlStat: return {kMockAckOk, state_.dpCtrlStat, true};
      case kDpSelect: return {kMockAckOk, state_.dpSelect & 0xFF0000FFu, true};
      case kDpRdbuff: return {kMockAckOk, state_.rdbuff, true};
      default: return {kMockAckFault, 0, false};  // undefined DP address
    }
  }
  switch (regAddr) {
    case kDpAbortIdcode: {
      // DP ABORT: each bit clears the matching sticky flag (W1C).
      uint32_t clearMask = 0;
      if (value & 0x02u) clearMask |= kStickyCmp;   // STKCMPCLR
      if (value & 0x04u) clearMask |= kStickyErr;   // STKERRCLR
      if (value & 0x08u) clearMask |= kWdataErr;    // WDERRCLR
      if (value & 0x10u) clearMask |= kStickyOrun;  // ORUNERRCLR
      state_.dpCtrlStat &= ~clearMask;
      break;
    }
    case kDpCtrlStat: {
      // CTRL/STAT: sticky bits are W1C; ORUNDETECT (bit 0) is R/W.
      state_.dpCtrlStat &= ~(value & (kStickyOrun | kStickyErr | kStickyCmp | kWdataErr));
      state_.dpCtrlStat = (state_.dpCtrlStat & ~1u) | (value & 1u);
      if ((value & (kMockCtrlStatCsyspwrupreq | kMockCtrlStatCdbgpwrupreq)) ==
          (kMockCtrlStatCsyspwrupreq | kMockCtrlStatCdbgpwrupreq)) {
        state_.dpCtrlStat |= kMockCtrlStatCsyspwrupack | kMockCtrlStatCdbgpwrupack;
      }
      break;
    }
    case kDpSelect:
      state_.dpSelect = value;
      break;
    default:
      return {kMockAckFault, 0, false};  // undefined DP address
  }
  return {kMockAckOk, 0, false};
}

MockCmsisDapTransport::TransferOutcome MockCmsisDapTransport::accessAp(uint8_t regAddr, bool rnw,
                                                                       uint32_t value) {
  // Only AP 0 / APBANKSEL 0 exists; anything else faults with a sticky error.
  if ((state_.dpSelect >> 24) != 0 || ((state_.dpSelect >> 4) & 0x0F) != 0) {
    setSticky(kStickyErr);
    return {kMockAckFault, 0, false};
  }
  if (rnw) {
    // AP read pipelining: the response data is the capture of the previous
    // AP read; RDBUFF mirrors the capture of this read so the host's
    // [AP read][DP RDBUFF] pattern sees exactly this access's result.
    const uint32_t response = state_.apReadValid ? state_.apReadData : 0;
    uint32_t capture = 0;
    switch (regAddr) {
      case kApCsw:
        capture = state_.apCsw;
        break;
      case kApTar:
        capture = state_.apTar;
        break;
      case kApDrw: {
        if ((state_.apTar & 3u) != 0 || !cswShapeOk(state_.apCsw)) {
          setSticky(kStickyErr);
          return {kMockAckFault, 0, false};
        }
        capture = readMemWord(state_.apTar);
        state_.apTar = autoIncrementTar(state_.apTar);
        break;
      }
      default:
        capture = 0;  // reserved bank-0 register reads as zero
        break;
    }
    state_.apReadValid = true;
    state_.apReadData = capture;
    state_.rdbuff = capture;
    return {kMockAckOk, response, true};
  }
  switch (regAddr) {
    case kApCsw:
      state_.apCsw = value;
      break;
    case kApTar:
      state_.apTar = value;
      break;
    case kApDrw: {
      if ((state_.apTar & 3u) != 0 || !cswShapeOk(state_.apCsw)) {
        setSticky(kStickyErr);
        return {kMockAckFault, 0, false};
      }
      writeMemWord(state_.apTar, value);
      state_.apTar = autoIncrementTar(state_.apTar);
      break;
    }
    default:
      break;  // reserved bank-0 register write is ignored
  }
  return {kMockAckOk, 0, false};
}

MockCmsisDapTransport::TransferOutcome MockCmsisDapTransport::accessItem(uint8_t header,
                                                                         uint32_t writeValue) {
  // Official Transfer Request bits: bit0 = APnDP, bit1 = RnW, bits 3:2 =
  // A[3:2]. Value Match / Match Mask / Timestamp are not supported by the
  // simulated target and are refused with FAULT instead of being silently
  // misinterpreted.
  if ((header & kMockReqUnsupported) != 0) {
    return {kMockAckFault, 0, false};
  }
  const bool rnw = (header & kMockReqRnw) != 0;
  const bool ap = (header & kMockReqApnDp) != 0;
  const uint8_t regAddr = header & (kMockReqA2 | kMockReqA3);  // A[3:2] bits in place
  const bool drw = ap && regAddr == kApDrw;
  // DRW-access error injection. A failed transfer performs nothing and does
  // not consume the AP pipeline, exactly like a real WAIT/FAULT/NO_ACK.
  if (drw) {
    if (injection_.alwaysWait) return {kMockAckWait, 0, false};
    if (injection_.noAck) return {kMockAckNoAck, 0, false};
    if (injection_.waitBudget > 0) {
      --injection_.waitBudget;
      return {kMockAckWait, 0, false};
    }
    if (injection_.faultOnFirst && (state_.dpCtrlStat & kStickyErr) == 0) {
      injection_.faultOnFirst = false;
      setSticky(kStickyErr);
      return {kMockAckFault, 0, false};
    }
    if (injection_.stickyBlocks && (state_.dpCtrlStat & kStickyErr) != 0) {
      return {kMockAckFault, 0, false};
    }
  }
  if (ap) return accessAp(regAddr, rnw, writeValue);
  return accessDp(regAddr, rnw, writeValue);
}

std::vector<uint8_t> MockCmsisDapTransport::processTransfer(const uint8_t* data, size_t length,
                                                            const std::string& key) {
  // Official request layout: [0x05][DAP index][Transfer Count][Request...]
  // [Data...]. Official response layout: [0x05][Count][Transfer Response]
  // [Read Data...] - Count = transfers executed, Transfer Response = ONE
  // status byte of the last executed transfer, data follows it.
  if (key == "1234:5682" && length >= 3 && !isDpidrPrimeTransfer(data, length)) {
    // malformed-transfer device: reply with a count larger than requested so
    // the protocol layer must reject the response.
    return {kMockCmdTransfer, static_cast<uint8_t>(data[2] + 1), kMockAckOk};
  }
  if (length < 3 || data[2] == 0) {
    // Defensive: invalid request shape gets an empty-count response.
    return {kMockCmdTransfer, 0x00, kMockAckOk};
  }
  const uint8_t count = data[2];
  std::vector<uint8_t> readData;
  readData.reserve(static_cast<size_t>(count) * 4);
  uint8_t completed = 0;
  uint8_t status = kMockAckOk;
  size_t offset = 3;
  for (uint8_t i = 0; i < count; ++i) {
    if (offset >= length) {
      // Truncated request: the rest of the transfers were never seen by the
      // target; the batch stops with NO_ACK.
      status = kMockAckNoAck;
      break;
    }
    const uint8_t header = data[offset++];
    uint32_t writeValue = 0;
    if ((header & kMockReqRnw) == 0) {
      if (offset + 4 > length) {
        status = kMockAckNoAck;
        break;
      }
      writeValue = readLe32Value(data + offset);
      offset += 4;
    }
    const TransferOutcome outcome = accessItem(header, writeValue);
    if (outcome.ack != kMockAckOk) {
      // The failed transfer is NOT counted and contributes no data.
      status = outcome.ack;
      break;
    }
    if ((header & kMockReqRnw) != 0) pushLe32(readData, outcome.data);
    ++completed;
  }
  std::vector<uint8_t> response;
  response.reserve(3 + readData.size());
  response.push_back(kMockCmdTransfer);
  response.push_back(completed);
  response.push_back(status);
  response.insert(response.end(), readData.begin(), readData.end());
  return response;
}

std::vector<uint8_t> MockCmsisDapTransport::processTransferBlock(const uint8_t* data, size_t length,
                                                                 const std::string& key) {
  // Official request layout: [0x06][DAP index][Count (16-bit LE)]
  // [Transfer Request][Data...]. Official response layout: [0x06][Count
  // (16-bit LE)][Transfer Response][Read Data...].
  if (length < 5) {
    return {kMockCmdTransferBlock, 0x00, 0x00, kMockAckOk};
  }
  const bool rnw = (data[4] & kMockReqRnw) != 0;
  if (key == "1234:5684" && !rnw) {
    // write-unknown device: the write is applied to memory (the host can
    // verify it afterwards) but the reply declares a wrong count, so the
    // completion state of the write is unknown and must never be retried.
    const uint16_t count = static_cast<uint16_t>(data[2] | (data[3] << 8));
    uint32_t offset = 5;
    for (uint16_t i = 0; i < count && offset + 4 <= length; ++i) {
      const TransferOutcome outcome = accessItem(data[4], readLe32Value(data + offset));
      offset += 4;
      if (outcome.ack != kMockAckOk) break;
    }
    return {kMockCmdTransferBlock, 0x00, 0x00, kMockAckOk};
  }
  const uint16_t count = static_cast<uint16_t>(data[2] | (data[3] << 8));
  uint32_t offset = 5;
  uint16_t completed = 0;
  uint8_t status = kMockAckOk;
  std::vector<uint8_t> readData;
  readData.reserve(static_cast<size_t>(count) * 4);
  const bool apDrwRead = rnw && (data[4] & kMockReqApnDp) != 0 &&
                         (data[4] & (kMockReqA2 | kMockReqA3)) == kApDrw;
  for (uint16_t i = 0; i < count; ++i) {
    uint32_t writeValue = 0;
    if (!rnw) {
      if (offset + 4 > length) {
        status = kMockAckNoAck;
        break;
      }
      writeValue = readLe32Value(data + offset);
      offset += 4;
    }
    const TransferOutcome outcome = accessItem(data[4], writeValue);
    if (outcome.ack != kMockAckOk) {
      status = outcome.ack;
      break;
    }
    if (rnw) {
      // A single DAP_Transfer AP read returns the previous pipeline value;
      // the host then reads DP RDBUFF to consume the current AP capture. A
      // DAP_TransferBlock AP DRW response must expose each current capture,
      // so it starts at the TAR value left by that RDBUFF read instead of
      // replaying the consumed word.
      pushLe32(readData, apDrwRead ? state_.rdbuff : outcome.data);
    }
    ++completed;
  }
  std::vector<uint8_t> response;
  response.reserve(4 + readData.size());
  response.push_back(kMockCmdTransferBlock);
  response.push_back(static_cast<uint8_t>(completed & 0xFF));
  response.push_back(static_cast<uint8_t>((completed >> 8) & 0xFF));
  response.push_back(status);
  response.insert(response.end(), readData.begin(), readData.end());
  return response;
}

}  // namespace cmsis_dap_helper
