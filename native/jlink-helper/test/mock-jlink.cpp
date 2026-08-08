#include <array>
#include <cstdint>
#include <unordered_map>

namespace {
struct JLinkHwStatus {
  std::uint16_t vTarget;
  std::uint8_t tck;
  std::uint8_t tdi;
  std::uint8_t tdo;
  std::uint8_t tms;
  std::uint8_t tres;
  std::uint8_t trst;
};

bool opened = false;
bool connected = false;
bool halted = true;
std::uint32_t pc = 0x08000100u;
std::array<std::uint32_t, 6> breakpoints{};
std::unordered_map<std::uint32_t, std::uint8_t> memory;
bool rttStarted = false;
bool haltStateError = false;
bool targetLinkError = false;
std::uint32_t loopIterations = 0;
std::uint32_t hitBreakpoint = 0;

void writeMemoryWord(std::uint32_t address, std::uint32_t value) {
  for (std::uint32_t i = 0; i < 4; ++i) {
    memory[address + i] = static_cast<std::uint8_t>((value >> (i * 8)) & 0xFFu);
  }
}

void initializeRttMemory() {
  static constexpr std::uint32_t controlBlock = 0x20000100u;
  static constexpr std::uint32_t buffer = 0x20001000u;
  static constexpr std::uint32_t descriptor = controlBlock + 24u;
  static constexpr std::uint32_t bufferSize = 16u;
  static constexpr char magic[] = "SEGGER RTT";
  for (std::uint32_t i = 0; i < 10; ++i) memory[controlBlock + i] = static_cast<std::uint8_t>(magic[i]);
  writeMemoryWord(controlBlock + 16u, 1u);
  writeMemoryWord(controlBlock + 20u, 0u);
  writeMemoryWord(descriptor + 4u, buffer);
  writeMemoryWord(descriptor + 8u, bufferSize);
  writeMemoryWord(descriptor + 12u, 3u);
  writeMemoryWord(descriptor + 16u, 0u);
  memory[buffer] = 'M';
  memory[buffer + 1u] = 'E';
  memory[buffer + 2u] = 'M';
}
}

extern "C" {

int __cdecl JLINK_GetDLLVersion() { return 99901; }

int __cdecl JLINK_Open() {
  opened = true;
  return 0;
}

int __cdecl JLINK_ExecCommand(const char*, char*, int) { return opened ? 0 : -1; }
int __cdecl JLINK_SetSpeed(int) { return opened ? 0 : -1; }
int __cdecl JLINK_TIF_Select(int) { return opened ? 0 : -1; }

int __cdecl JLINK_Connect() {
  if (!opened) return -1;
  connected = true;
  halted = true;
  initializeRttMemory();
  return 0;
}

int __cdecl JLINK_Halt() {
  if (!connected) return -1;
  halted = true;
  return 0;
}

int __cdecl JLINK_Go() {
  if (!connected) return -1;
  if (pc >= 0x08000500u && pc < 0x0800050Au) {
    std::uint32_t nextBreakpoint = 0;
    for (const std::uint32_t breakpoint : breakpoints) {
      if (breakpoint > pc && (nextBreakpoint == 0 || breakpoint < nextBreakpoint)) {
        nextBreakpoint = breakpoint;
      }
    }
    if (nextBreakpoint != 0) {
      pc = nextBreakpoint;
      hitBreakpoint = pc;
      halted = true;
      return 0;
    }
  }
  for (const std::uint32_t breakpoint : breakpoints) {
    if (breakpoint != 0) {
      pc = breakpoint;
      hitBreakpoint = pc;
      halted = true;
      return 0;
    }
  }
  halted = false;
  return 0;
}

int __cdecl JLINK_Step() {
  if (!connected) return -1;
  if (hitBreakpoint == pc) {
    for (const std::uint32_t breakpoint : breakpoints) {
      if (breakpoint == pc) return 0;
    }
  }
  hitBreakpoint = 0;
  if (pc >= 0x08000400u && pc < 0x08000418u) {
    if (pc == 0x08000416u) {
      ++loopIterations;
      pc = loopIterations < 4 ? 0x08000400u : 0x08000418u;
    } else {
      pc += 2;
    }
  } else {
    pc = pc == 0x08000108u ? 0x08001000u : pc + 2;
  }
  halted = true;
  return 0;
}

int __cdecl JLINK_Reset() {
  if (!connected) return -1;
  pc = 0x08000100u;
  loopIterations = 0;
  hitBreakpoint = 0;
  halted = true;
  return 0;
}

int __cdecl JLINK_IsHalted() {
  if (haltStateError) return -1;
  return connected && halted ? 1 : 0;
}
int __cdecl JLINK_IsConnected() { return connected ? 1 : 0; }
int __cdecl JLINK_CORESIGHT_ReadAPDPReg(std::uint8_t, std::uint8_t, std::uint32_t* data) {
  if (!connected || targetLinkError || !data) return -1;
  *data = 0x2BA01477u;
  return 0;
}
int __cdecl JLINK_GetHWStatus(JLinkHwStatus* status) {
  if (!opened || !status) return 1;
  *status = JLinkHwStatus{3300, 0, 0, 0, 0, 0, 0};
  return 0;
}

int __cdecl JLINK_ReadReg(int index) {
  if (!connected || index < 0) return -1;
  if (index == 15) return static_cast<int>(pc);
  if (index == 14) return static_cast<int>(0x08000201u);
  if (index == 13) return static_cast<int>(0x20001000u);
  return static_cast<int>(0x08000100u + static_cast<std::uint32_t>(index * 4));
}

int __cdecl JLINK_ReadMem(std::uint32_t address, std::uint32_t size, void* destination) {
  if (!connected || !destination) return -1;
  auto* bytes = static_cast<std::uint8_t*>(destination);
  for (std::uint32_t i = 0; i < size; ++i) {
    const auto stored = memory.find(address + i);
    bytes[i] = stored == memory.end() ? static_cast<std::uint8_t>((address + i) & 0xFFu) : stored->second;
  }
  if (address == 0x08000100u && size >= 4) {
    bytes[0] = 0x00;
    bytes[1] = 0xF0;
    bytes[2] = 0x00;
    bytes[3] = 0xD0;
  }
  if (address == 0x08000108u && size >= 4) {
    bytes[0] = 0x00;
    bytes[1] = 0xF0;
    bytes[2] = 0x00;
    bytes[3] = 0xD0;
  }
  if ((address == 0x08000500u || address == 0x08000504u) && size >= 4) {
    bytes[0] = 0x00;
    bytes[1] = 0xF0;
    bytes[2] = 0x00;
    bytes[3] = 0xD0;
  }
  if (address == 0x08000416u && size >= 2) {
    bytes[0] = 0xFE;
    bytes[1] = 0xE7;
  }
  if (address >= 0x20000100u && address < 0x20001020u) return 0;
  return static_cast<int>(size);
}

int __cdecl JLINK_WriteMem(std::uint32_t address, std::uint32_t size, const void* source) {
  if (!connected || !source) return -1;
  const auto* bytes = static_cast<const std::uint8_t*>(source);
  if (address == 0xFFFF0000u && size > 0) haltStateError = bytes[0] != 0;
  if (address == 0xFFFF0004u && size > 0) targetLinkError = bytes[0] != 0;
  for (std::uint32_t i = 0; i < size; ++i) memory[address + i] = bytes[i];
  if (address == 0x20000100u + 24u + 16u) return 0;
  return static_cast<int>(size);
}

int __cdecl JLINK_SetBP(std::uint32_t slot, std::uint32_t address) {
  if (!connected || slot >= breakpoints.size() || address == 0 || breakpoints[slot] != 0) return -1;
  breakpoints[slot] = address;
  return static_cast<int>(slot);
}

int __cdecl JLINK_ClrBP(std::uint32_t slot) {
  if (!connected || slot >= breakpoints.size()) return -1;
  if (breakpoints[slot] == hitBreakpoint) hitBreakpoint = 0;
  breakpoints[slot] = 0;
  return 0;
}

int __cdecl JLINK_RTTERMINAL_Control(std::uint32_t command, void*) {
  if (!connected) return -1;
  if (command == 0) rttStarted = true;
  else if (command == 1) rttStarted = false;
  else return -1;
  return 0;
}

int __cdecl JLINK_RTTERMINAL_Read(std::uint32_t, void* destination, std::uint32_t size) {
  if (!connected || !rttStarted || !destination) return -1;
  static constexpr std::array<std::uint8_t, 3> data{'R', 'T', 'T'};
  const std::uint32_t count = size < data.size() ? size : static_cast<std::uint32_t>(data.size());
  auto* bytes = static_cast<std::uint8_t*>(destination);
  for (std::uint32_t i = 0; i < count; ++i) bytes[i] = data[i];
  return static_cast<int>(count);
}

}
