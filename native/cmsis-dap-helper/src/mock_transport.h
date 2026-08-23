#pragma once

#include <cstdint>
#include <deque>
#include <array>
#include <string>
#include <vector>

#include "cmsis_dap_transport.h"

namespace cmsis_dap_helper {

// Official CMSIS-DAP wire values, defined INDEPENDENTLY of the production
// protocol constants (cmsis_dap_protocol.h) so that the mock acts as a
// separate oracle: mock tests must never reuse the production command ids or
// bit-field packing logic as their only source of truth.
// (group__DAP__Transfer.html / group__DAP__TransferBlock.html)
inline constexpr uint8_t kMockCmdInfo = 0x00;
inline constexpr uint8_t kMockCmdConnect = 0x02;
inline constexpr uint8_t kMockCmdDisconnect = 0x03;
inline constexpr uint8_t kMockCmdTransferConfigure = 0x04;
inline constexpr uint8_t kMockCmdResetTarget = 0x0A;
inline constexpr uint8_t kMockCmdSwjPins = 0x10;
inline constexpr uint8_t kMockCmdSwjClock = 0x11;
inline constexpr uint8_t kMockCmdSwjSequence = 0x12;
inline constexpr uint8_t kMockCmdSwdConfigure = 0x13;
inline constexpr uint8_t kMockCmdTransfer = 0x05;
inline constexpr uint8_t kMockCmdTransferBlock = 0x06;
inline constexpr uint8_t kMockCmdWriteAbort = 0x08;

// Transfer Request bits (official): bit0 = APnDP, bit1 = RnW, bit2 = A2,
// bit3 = A3. Value Match (0x10), Match Mask (0x20) and Timestamp (0x80) are
// not supported by the simulated target and are refused with FAULT.
inline constexpr uint8_t kMockReqApnDp = 0x01;
inline constexpr uint8_t kMockReqRnw = 0x02;
inline constexpr uint8_t kMockReqA2 = 0x04;
inline constexpr uint8_t kMockReqA3 = 0x08;
inline constexpr uint8_t kMockReqUnsupported = 0xB0;

// Transfer Response ACK values (bits 2..0 of the status byte, official).
inline constexpr uint8_t kMockAckOk = 0x01;
inline constexpr uint8_t kMockAckWait = 0x02;
inline constexpr uint8_t kMockAckFault = 0x04;
inline constexpr uint8_t kMockAckNoAck = 0x07;

// Mock target memory layout (STM32F407VET6-like).
constexpr uint32_t kMockRamBase = 0x20000000u;
constexpr uint32_t kMockRamSize = 128 * 1024u;
constexpr uint32_t kMockFlashBase = 0x08000000u;
constexpr uint32_t kMockFlashSize = 512 * 1024u;
constexpr uint32_t kMockCoreDebugDhcsr = 0xE000EDF0u;
constexpr uint32_t kMockCoreDebugDcrsr = 0xE000EDF4u;
constexpr uint32_t kMockCoreDebugDcrdr = 0xE000EDF8u;
constexpr uint32_t kMockCoreDebugAircr = 0xE000ED0Cu;
constexpr uint32_t kMockCoreDebugSHalt = 1u << 17;
constexpr uint32_t kMockCoreDebugSRegReady = 1u << 16;
constexpr uint32_t kMockCoreDebugSRetireSt = 1u << 24;
constexpr uint32_t kMockCoreDebugRegWrite = 1u << 16;
constexpr uint32_t kMockCoreDebugCDebugEn = 1u << 0;
constexpr uint32_t kMockCoreDebugCHalt = 1u << 1;
constexpr uint32_t kMockCoreDebugCStep = 1u << 2;
constexpr uint32_t kMockCoreDebugCMaskInts = 1u << 3;
constexpr uint32_t kMockCoreDebugDbgKey = 0xA05Fu << 16;
constexpr uint32_t kMockCoreDebugVectKey = 0x5FAu << 16;
constexpr uint32_t kMockCoreDebugSysResetReq = 1u << 2;
constexpr uint32_t kMockResetPc = 0x080001C0u;
constexpr uint32_t kMockStartupEntryPc = 0x080001E0u;
constexpr uint32_t kMockPostStartupPc = 0x08000220u;
constexpr uint32_t kMockFpbCtrl = 0xE0002000u;
constexpr uint32_t kMockFpbComp0 = 0xE0002008u;
constexpr uint32_t kMockFpbCodeComparators = 6u;
constexpr uint32_t kMockFpbCtrlReset = (2u << 8) | (kMockFpbCodeComparators << 4);
constexpr uint32_t kMockCtrlStatCsyspwrupreq = 1u << 30;
constexpr uint32_t kMockCtrlStatCsyspwrupack = 1u << 31;
constexpr uint32_t kMockCtrlStatCdbgpwrupreq = 1u << 28;
constexpr uint32_t kMockCtrlStatCdbgpwrupack = 1u << 29;

// Deterministic fill pattern for RAM and non-vector flash addresses: the
// little-endian word at aligned address A is (A ^ 0xA5A5A5A5), so every read
// is exactly reproducible by the tests.
inline uint32_t mockWordAt(uint32_t address) { return address ^ 0xA5A5A5A5u; }
inline uint8_t mockByteAt(uint32_t address) {
  return static_cast<uint8_t>(mockWordAt(address & ~3u) >> (8 * (address & 3u)));
}

// Explicit STM32F407-like vector-table fixture. These values are written into
// the mock flash image when a device is opened so a skipped first word cannot
// be hidden by the deterministic fill pattern.
constexpr uint32_t kMockFlashVectorWord0 = 0x20006FA8u;
constexpr uint32_t kMockFlashVectorWord1 = 0x080001C1u;
constexpr uint32_t kMockFlashVectorWord2 = 0x08000421u;
constexpr uint32_t kMockFlashVectorWord3 = 0x08000461u;

// Simulated target profile. The default models the STM32F407VET6 baseline;
// the 1234:5690 fixture selects the STM32H723VGT6 profile (uniform 128 KiB
// sectors, 256-bit ECC flash words). All values are independent mock fixtures
// maintained here as the protocol oracle; they are not shared with the
// production target registry.
struct MockTargetProfile {
  uint32_t dpIdcode = 0x2BA01477u;       // F407 SW-DP IDCODE (SW-DP v1)
  uint32_t idcodeAddress = 0xE0042000u;  // DBGMCU_IDCODE register
  uint32_t idcodeValue = 0x10006413u;    // DEV_ID 0x413, REV_ID 0x1000
  // Word-sized fixture whose bytes encode the Flash size in KiB at the
  // offset the preflight reads (F4: high half at +2; H723: low half at +0).
  uint32_t flashSizeWordAddress = 0x1FFF7A20u;
  uint32_t flashSizeWordValue = 0x00020000u;
  uint32_t ramBase = 0x20000000u;
  uint32_t ramSize = 128u * 1024u;
  uint32_t flashBase = 0x08000000u;
  uint32_t flashSize = 512u * 1024u;
  // 0 keeps the legacy permissive erase window (F4's mixed sectors); a
  // nonzero value requires erases to cover exactly one aligned sector.
  uint32_t flashSectorSize = 0;
  // 0 keeps the legacy per-byte 1->0 programming; a nonzero value only
  // allows programming into fully erased flash words of that byte size
  // (ECC rule: a flash word must never be programmed twice).
  uint32_t flashWordSize = 0;
};

// SW-DP / MEM-AP simulation state. Matches the ADIv5 semantics the target
// layer relies on: DP registers IDCODE/CTRL-STAT/SELECT/RDBUFF, a single
// MEM-AP with CSW/TAR/DRW, AP read pipelining (a read returns the data
// captured by the previous AP read; RDBUFF holds the latest capture), TAR
// auto-increment that wraps at the 1 KiB boundary, and CSW 32-bit/single
// shape validation. Unmapped addresses read as zero.
struct MockSwdState {
  uint32_t dpIdcode = 0x2BA01477u;  // STM32F407VET6 Cortex-M4 SW-DP IDCODE
  MockTargetProfile profile;        // memory map / flash geometry (F4 default)
  uint32_t dpCtrlStat = 0;
  uint32_t dpSelect = 0;
  uint32_t rdbuff = 0;
  uint32_t apCsw = 0;
  uint32_t apTar = 0;
  uint32_t apReadData = 0;  // data captured by the previous AP read
  bool apReadValid = false;
  std::vector<uint8_t> ram;
  std::vector<uint8_t> flash;
  uint32_t dhcsr = kMockCoreDebugCDebugEn;
  uint32_t dcrsr = 0;
  uint32_t dcrdr = 0;
  uint32_t aircr = 0;
  uint32_t lastDhcsrWrite = 0;
  uint32_t lastAircrWrite = 0;
  uint32_t pendingStepDhcsrReads = 0;
  uint32_t pendingStepDhcsrWrite = 0;
  bool stepInterrupted = false;
  uint32_t interruptedStepPc = 0;
  std::array<uint32_t, 21> registers{};
  uint32_t fpCtrl = kMockFpbCtrlReset;
  std::array<uint32_t, kMockFpbCodeComparators> fpComp{};
};

// Per-device error injection knobs, enabled by vid:pid.
struct MockInjection {
  uint32_t waitBudget = 0;      // 1234:567F - first N DRW accesses WAIT
  bool faultOnFirst = false;    // 1234:5680 - first DRW access FAULTs
  bool stickyBlocks = false;    // 1234:5680 - DRW stays FAULT until ABORT
  bool noAck = false;           // 1234:5681 - every DRW access NO_ACKs
  bool alwaysWait = false;      // 1234:5683 - every DRW access WAITs
  bool malformedTransfer = false;  // 1234:5682 - corrupt DAP_Transfer replies
  bool writeUnknown = false;    // 1234:5684 - corrupt DAP_TransferBlock write replies
  bool removedOnTransfer = false;  // 1234:5685 - first transfer unplugs the device
  bool controlStuck = false;       // 1234:5686 - CoreDebug writes never change state
  bool flashBusy = false;          // 1234:5687 - algorithm returns a busy error
  bool flashProtected = false;     // 1234:5688 - erase/program returns protection error
  bool verifyCorruption = false;   // 1234:5689 - program corrupts a byte before verify
  bool flashRemoved = false;       // 1234:568A - device disappears during algorithm
  bool flashAlgorithmStuck = false; // 1234:568B - algorithm remains running
  bool fpbNeverHits = false;        // 1234:568C - run ignores enabled FPB comparators
  uint32_t stepDhcsrLagReads = 0;   // 1234:568D - C_STEP completion is not immediately visible
  bool fpbHitsCurrentPc = false;    // 1234:568D - restored current-PC comparator re-halts
  bool interruptOnUnmaskedStep = false;  // 1234:568E - timer IRQ steals an unmasked C_STEP
  bool interruptOnUnmaskedAlgorithmStart = false;  // 1234:568E - IRQ steals Flash entry
  bool resetRunsPastStartupEntry = false;  // 1234:568F - reset reaches post-startup code before returning
  bool algorithmInterruptMaskAtEntry = false;
  bool removalConsumed = false;
  uint32_t transferCount = 0;   // DAP_Transfer commands seen
  uint32_t blockReadCount = 0;  // DAP_TransferBlock read commands seen
  uint32_t blockWriteCount = 0; // DAP_TransferBlock write commands seen
  uint32_t flashAlgorithmCount = 0;
  uint32_t flashEraseCount = 0;
  uint32_t flashProgramCount = 0;
  uint32_t flashVerifyCount = 0;
  uint32_t algorithmR0AtEntry = 0;
  uint32_t algorithmR1AtEntry = 0;
  uint32_t algorithmR2AtEntry = 0;
  uint32_t algorithmR3AtEntry = 0;
  uint32_t algorithmR9AtEntry = 0;
  uint32_t algorithmSpAtEntry = 0;
  uint32_t algorithmLrAtEntry = 0;
  uint32_t algorithmPcAtEntry = 0;
  uint32_t algorithmXpsrAtEntry = 0;
};

struct MockFlashAlgorithmRequest {
  bool pending = false;
  bool ramStub = false;
  std::string operation;
  uint32_t address = 0;
  uint32_t size = 0;
  uint32_t bkptAddress = 0;
  std::vector<uint8_t> data;
};

// In-memory CMSIS-DAP transport used by mock tests. It implements the same
// CmsisDapTransport contract as the HID transport so framing and protocol
// behavior can be exercised without real USB hardware.
//
// Built-in devices (selected via vid/pid filters):
//  - 1234:5678 "normal"        official layout: DAP_Info [0x00][len][data]
//                              (strings include the NUL terminator), DAP_Info
//                              ids 0xF0/0xFE/0xFF, DAP_Connect [0x02][port],
//                              DAP_Disconnect [0x03][status=OK]; full
//                              SW-DP/MEM-AP target simulation
//  - 1234:5679 "empty-info"    DAP_Info returns len=0 for everything (the
//                              official "no information" response), the rest
//                              behaves like normal
//  - 1234:567A "corrupt"       DAP_Info(0xFF) replies with command byte 0xFF
//                              (official "command not implemented" reply),
//                              DAP_Connect replies with an invalid port byte
//                              0xFF, DAP_Disconnect replies with status
//                              DAP_ERROR (0xFF)
//  - 1234:567B "silent"        never responds; readPacket waits the full
//                              timeout and fails with kReadTimeout
//  - 1234:567C "report-id-1"   reportId=1, 33/33-byte reports (32 payload)
//  - 1234:567D "vendor-echo"   legacy layout: DAP_Info echoes the info id
//                              ([cmd][infoId][len][data]), DAP_Connect has an
//                              extra status byte ([cmd][status][port]). No
//                              real device is known to need this; the mock
//                              exists for future compatibility checks only
//                              and is NOT exercised by the smoke suite.
//  - 1234:567E "connect-fail"  official layout but DAP_Connect reports
//                              port 0 (initialization failed)
//  - 1234:567F "wait-once"     the first 2 DRW accesses answer WAIT, then
//                              the target works normally
//  - 1234:5680 "fault-once"    the first DRW access answers FAULT and sets
//                              STICKYERR; DRW stays FAULT until the host
//                              clears it through the DP ABORT register
//  - 1234:5681 "no-ack"        every DRW access answers NO_ACK (target gone)
//  - 1234:5682 "malformed"     DAP_Transfer replies with an inconsistent
//                              transfer count (truncated protocol)
//  - 1234:5683 "busy"          every DRW access answers WAIT forever
//  - 1234:5684 "write-unknown" DAP_TransferBlock writes apply to memory but
//                              reply with a wrong count, so the completion
//                              state of the write is unknown
//  - 1234:5685 "removal"       the first DAP_Transfer command marks the
//                              device removed; everything after fails with
//                              kDeviceRemoved
  //  - 1234:5686 "control-stuck" CoreDebug writes are accepted but do not
  //                              change DHCSR/AIRCR state, exercising the
  //                              bounded DapControlTimeout path
//  - 1234:5687..568A flash algorithm busy/protected/corrupt/removed cases
//  - 1234:568C "fpb-no-hit"    FPB writes/readback work, but run never
//                              reports a comparator hit (step timeout oracle)
//  - 1234:568D "step-retire-lag" C_STEP initially reads as the old halted
//                              state; restoring the current-PC comparator
//                              before instruction retirement re-halts it
//  - 1234:568E "step-interrupt" an unmasked C_STEP enters a timer ISR, then
//                              returns to the still-armed current-PC breakpoint;
//                              an unmasked Flash Algorithm resume is likewise
//                              preempted before its first instruction
//  - 1234:568F "reset-race" reset passes the startup entry unless its FPB
//                              comparator was armed before SYSRESETREQ
//  - 1234:5690 "h723"         STM32H723VGT6 profile: SW-DP v2 IDCODE
//                              0x6BA02477, DBGMCU_IDCODE at 0x5C001000
//                              (DEV_ID 0x483), Flash size 1 MiB in 8 uniform
//                              128 KiB sectors, 256-bit ECC flash words
//                              (no double programming), loader RAM window at
//                              AXI SRAM 0x24000000
class MockCmsisDapTransport : public CmsisDapTransport {
 public:
  MockCmsisDapTransport();

  std::string transportName() const override { return "mock"; }

  Result enumerate(const DeviceSelector& selector, std::vector<DeviceDescriptor>& out) override;
  Result open(const DeviceDescriptor& device) override;
  Result close() override;
  bool isOpen() const override { return opened_; }

  Result writePacket(const uint8_t* data, size_t length,
                     std::chrono::milliseconds timeout) override;
  Result readPacket(uint8_t* data, size_t capacity, size_t& length,
                    std::chrono::milliseconds timeout) override;
  Result drainInput(std::chrono::milliseconds timeout) override;
  size_t payloadCapacity() const override {
    return opened_ && selected_.outputReportLength > 1
               ? static_cast<size_t>(selected_.outputReportLength) - 1
               : 0;
  }
  bool deviceLost() const override { return lost_; }
  TransportIoCounters ioCounters() const override { return ioCounters_; }

  // Mock target introspection used by the helper self-test.
  const MockSwdState& targetState() const { return state_; }
  const MockInjection& injection() const { return injection_; }

  // Raw request bytes captured from the last DAP_Transfer / DAP_TransferBlock
  // command, exactly as written to the wire. Used by the self-test to verify
  // the production request encoding against the official layout.
  const std::vector<uint8_t>& lastTransferRequest() const { return lastTransferRequest_; }
  const std::vector<uint8_t>& lastBlockRequest() const { return lastBlockRequest_; }
  const std::vector<uint8_t>& commandHistory() const { return commandHistory_; }

  // ADIv5/MEM-AP CSW shape validation (Size=bits[2:0] 32-bit, AddrInc=bits[5:4]
  // single; DeviceEn is bit6 and is not part of this check). Exposed publicly
  // so the helper self-test can assert the exact accepted/rejected encodings
  // independently of a target session.
  static bool cswShapeOk(uint32_t csw);

  // Configures the one-shot RAM algorithm simulation used only by the mock
  // self-test. Production HID devices execute the bytes supplied by the
  // flashAlgorithm RPC on the target Cortex-M instead.
  void prepareFlashAlgorithm(const std::string& operation, uint32_t address, uint32_t size,
                             const std::vector<uint8_t>& data, uint32_t bkptAddress);
  void prepareRamStub(uint32_t entry, uint32_t bkptAddress);
  void prepareExceptionReturn(uint32_t handlerPc, uint32_t excReturn,
                              uint32_t frameSp, uint32_t stackedPc);
  void prepareSourceInstruction(uint32_t pc, const std::vector<uint8_t>& bytes);

 private:
  struct TransferOutcome {
    uint8_t ack = kMockAckNoAck;
    uint32_t data = 0;
    bool dataValid = false;
  };

  static DeviceDescriptor makeDevice(const std::string& vid, const std::string& pid,
                                     const std::string& serial, uint16_t inputReportLength,
                                     uint16_t outputReportLength, uint8_t reportId);
  static std::vector<uint8_t> stringPayload(const std::string& value);
  static std::string behaviorKey(const DeviceDescriptor& device);

  std::vector<uint8_t> dapInfoResponse(const uint8_t* data, size_t length,
                                       const std::string& key) const;
  std::vector<uint8_t> dapConnectResponse(const uint8_t* data, size_t length,
                                          const std::string& key) const;
  std::vector<uint8_t> dapDisconnectResponse(const std::string& key) const;

  // DAP_Transfer / DAP_TransferBlock processing against the simulated target.
  std::vector<uint8_t> processTransfer(const uint8_t* data, size_t length,
                                       const std::string& key);
  std::vector<uint8_t> processTransferBlock(const uint8_t* data, size_t length,
                                            const std::string& key);
  TransferOutcome accessItem(uint8_t header, uint32_t writeValue);
  TransferOutcome accessDp(uint8_t regAddr, bool rnw, uint32_t value);
  TransferOutcome accessAp(uint8_t regAddr, bool rnw, uint32_t value);
  uint32_t readMemWord(uint32_t address);
  void writeMemWord(uint32_t address, uint32_t value);
  void setSticky(uint32_t bit) { state_.dpCtrlStat |= bit; }
  static uint32_t autoIncrementTar(uint32_t tar);
  void runPreparedFlashAlgorithm();
  void runPreparedRamStub();

  std::vector<DeviceDescriptor> devices_;
  DeviceDescriptor selected_;
  bool opened_ = false;
  bool lost_ = false;
  std::deque<std::vector<uint8_t>> pending_;
  MockSwdState state_;
  MockInjection injection_;
  std::vector<uint8_t> lastTransferRequest_;
  std::vector<uint8_t> lastBlockRequest_;
  std::vector<uint8_t> commandHistory_;
  MockFlashAlgorithmRequest preparedFlashAlgorithm_;
  TransportIoCounters ioCounters_;
};

}  // namespace cmsis_dap_helper
