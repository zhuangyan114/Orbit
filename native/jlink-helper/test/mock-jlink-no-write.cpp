#include <array>
#include <cstdint>
#include <cstring>
#include <unordered_map>

namespace {

bool opened = false;
bool connected = false;
bool halted = true;
std::uint32_t pc = 0x08000100u;
std::array<std::uint32_t, 6> breakpoints{};
std::unordered_map<std::uint32_t, std::uint8_t> memory;

void writeWord(std::uint32_t address, std::uint32_t value) {
  for (std::uint32_t i = 0; i < 4; ++i) {
    memory[address + i] = static_cast<std::uint8_t>((value >> (i * 8u)) & 0xFFu);
  }
}

void writeCString(std::uint32_t address, const char* text) {
  const std::size_t length = std::strlen(text);
  for (std::size_t i = 0; i <= length; ++i) {
    memory[address + static_cast<std::uint32_t>(i)] = static_cast<std::uint8_t>(text[i]);
  }
}

void writeDescriptor(std::uint32_t address, std::uint32_t nameAddr, std::uint32_t bufAddr,
                     std::uint32_t size, std::uint32_t wrOff, std::uint32_t rdOff, std::uint32_t flags) {
  writeWord(address, nameAddr);
  writeWord(address + 4u, bufAddr);
  writeWord(address + 8u, size);
  writeWord(address + 12u, wrOff);
  writeWord(address + 16u, rdOff);
  writeWord(address + 20u, flags);
}

void initializeRttFixture() {
  constexpr std::uint32_t cb = 0x20000100u;
  constexpr std::uint32_t nameTerm = 0x20000400u;
  constexpr std::uint32_t nameSysView = 0x20000420u;
  constexpr char magic[] = "SEGGER RTT";
  for (std::uint32_t i = 0; i < 10u; ++i) memory[cb + i] = static_cast<std::uint8_t>(magic[i]);
  writeWord(cb + 16u, 2u);
  writeWord(cb + 20u, 1u);
  writeCString(nameTerm, "Terminal");
  writeCString(nameSysView, "SysView");
  writeDescriptor(cb + 24u, nameTerm, 0x20001000u, 64u, 3u, 0u, 0u);
  writeDescriptor(cb + 48u, nameSysView, 0x20001100u, 64u, 0u, 0u, 0u);
  writeDescriptor(cb + 72u, nameSysView, 0x20001200u, 64u, 0u, 0u, 0u);
  memory[0x20001000u] = 'H';
  memory[0x20001001u] = 'I';
  memory[0x20001002u] = '!';
}

}  // namespace

extern "C" {

int __cdecl JLINK_GetDLLVersion() { return 79000; }
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
  initializeRttFixture();
  return 0;
}
int __cdecl JLINK_Halt() {
  if (!connected) return -1;
  halted = true;
  return 0;
}
int __cdecl JLINK_Go() {
  if (!connected) return -1;
  halted = false;
  return 0;
}
int __cdecl JLINK_Step() {
  if (!connected) return -1;
  pc += 2u;
  halted = true;
  return 0;
}
int __cdecl JLINK_Reset() {
  if (!connected) return -1;
  pc = 0x08000100u;
  halted = true;
  return 0;
}
int __cdecl JLINK_IsHalted() { return connected && halted ? 1 : 0; }
int __cdecl JLINK_IsConnected() { return connected ? 1 : 0; }
int __cdecl JLINK_ReadReg(int index) {
  if (!connected || index < 0) return -1;
  if (index == 15) return static_cast<int>(pc);
  return 0;
}
int __cdecl JLINK_ReadMem(std::uint32_t address, std::uint32_t size, void* destination) {
  if (!connected || !destination) return -1;
  auto* bytes = static_cast<std::uint8_t*>(destination);
  for (std::uint32_t i = 0; i < size; ++i) {
    const auto it = memory.find(address + i);
    bytes[i] = it == memory.end() ? 0u : it->second;
  }
  return 0;
}
int __cdecl JLINK_SetBP(std::uint32_t slot, std::uint32_t address) {
  if (!connected || slot >= breakpoints.size() || address == 0) return -1;
  breakpoints[slot] = address;
  return static_cast<int>(slot);
}
int __cdecl JLINK_ClrBP(std::uint32_t slot) {
  if (!connected || slot >= breakpoints.size()) return -1;
  breakpoints[slot] = 0;
  return 0;
}

}
