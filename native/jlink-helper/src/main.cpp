#include <windows.h>

#include <array>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kProtocolVersion = 2;
constexpr int kBreakpointSlots = 6;

struct JsonValue {
  enum class Kind { Null, Boolean, Number, String, Object, Array };
  Kind kind = Kind::Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  std::map<std::string, JsonValue> object;
  std::vector<JsonValue> array;

  const JsonValue* get(const std::string& key) const {
    const auto it = object.find(key);
    return it == object.end() ? nullptr : &it->second;
  }
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& source) : source_(source) {}

  JsonValue parse() {
    JsonValue value = parseValue();
    skipWhitespace();
    if (position_ != source_.size()) fail("unexpected trailing data");
    return value;
  }

 private:
  JsonValue parseValue() {
    skipWhitespace();
    if (position_ >= source_.size()) fail("unexpected end of input");
    const char ch = source_[position_];
    if (ch == '{') return parseObject();
    if (ch == '[') return parseArray();
    if (ch == '"') {
      JsonValue value;
      value.kind = JsonValue::Kind::String;
      value.string = parseString();
      return value;
    }
    if (ch == '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (consumeLiteral("true")) {
      JsonValue value;
      value.kind = JsonValue::Kind::Boolean;
      value.boolean = true;
      return value;
    }
    if (consumeLiteral("false")) {
      JsonValue value;
      value.kind = JsonValue::Kind::Boolean;
      return value;
    }
    if (consumeLiteral("null")) return JsonValue{};
    fail("unsupported JSON value");
  }

  JsonValue parseObject() {
    JsonValue value;
    value.kind = JsonValue::Kind::Object;
    ++position_;
    skipWhitespace();
    if (consume('}')) return value;
    while (true) {
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_] != '"') fail("object key must be a string");
      const std::string key = parseString();
      skipWhitespace();
      if (!consume(':')) fail("expected ':'");
      value.object.emplace(key, parseValue());
      skipWhitespace();
      if (consume('}')) return value;
      if (!consume(',')) fail("expected ',' or '}'");
    }
  }

  JsonValue parseArray() {
    JsonValue value;
    value.kind = JsonValue::Kind::Array;
    ++position_;
    skipWhitespace();
    if (consume(']')) return value;
    while (true) {
      value.array.push_back(parseValue());
      skipWhitespace();
      if (consume(']')) return value;
      if (!consume(',')) fail("expected ',' or ']'");
    }
  }

  std::string parseString() {
    if (!consume('"')) fail("expected string");
    std::string result;
    while (position_ < source_.size()) {
      const char ch = source_[position_++];
      if (ch == '"') return result;
      if (ch != '\\') {
        result.push_back(ch);
        continue;
      }
      if (position_ >= source_.size()) fail("unterminated escape");
      const char escaped = source_[position_++];
      switch (escaped) {
        case '"': result.push_back('"'); break;
        case '\\': result.push_back('\\'); break;
        case '/': result.push_back('/'); break;
        case 'b': result.push_back('\b'); break;
        case 'f': result.push_back('\f'); break;
        case 'n': result.push_back('\n'); break;
        case 'r': result.push_back('\r'); break;
        case 't': result.push_back('\t'); break;
        case 'u': appendUnicodeEscape(result); break;
        default: fail("invalid string escape");
      }
    }
    fail("unterminated string");
  }

  void appendUnicodeEscape(std::string& result) {
    if (position_ + 4 > source_.size()) fail("short unicode escape");
    unsigned codePoint = 0;
    for (int i = 0; i < 4; ++i) {
      const char ch = source_[position_++];
      codePoint <<= 4;
      if (ch >= '0' && ch <= '9') codePoint += static_cast<unsigned>(ch - '0');
      else if (ch >= 'a' && ch <= 'f') codePoint += static_cast<unsigned>(ch - 'a' + 10);
      else if (ch >= 'A' && ch <= 'F') codePoint += static_cast<unsigned>(ch - 'A' + 10);
      else fail("invalid unicode escape");
    }
    if (codePoint <= 0x7F) {
      result.push_back(static_cast<char>(codePoint));
    } else if (codePoint <= 0x7FF) {
      result.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
      result.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else {
      result.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
      result.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    }
  }

  JsonValue parseNumber() {
    const std::size_t start = position_;
    if (source_[position_] == '-') ++position_;
    while (position_ < source_.size() && source_[position_] >= '0' && source_[position_] <= '9') ++position_;
    if (position_ < source_.size() && source_[position_] == '.') {
      ++position_;
      while (position_ < source_.size() && source_[position_] >= '0' && source_[position_] <= '9') ++position_;
    }
    JsonValue value;
    value.kind = JsonValue::Kind::Number;
    value.number = std::strtod(source_.substr(start, position_ - start).c_str(), nullptr);
    return value;
  }

  bool consume(char expected) {
    if (position_ < source_.size() && source_[position_] == expected) {
      ++position_;
      return true;
    }
    return false;
  }

  bool consumeLiteral(const char* literal) {
    const std::size_t length = std::char_traits<char>::length(literal);
    if (source_.compare(position_, length, literal) != 0) return false;
    position_ += length;
    return true;
  }

  void skipWhitespace() {
    while (position_ < source_.size()) {
      const char ch = source_[position_];
      if (ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n') break;
      ++position_;
    }
  }

  [[noreturn]] void fail(const std::string& message) const {
    throw std::runtime_error(message + " at byte " + std::to_string(position_));
  }

  const std::string& source_;
  std::size_t position_ = 0;
};

std::string jsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (ch < 0x20) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(ch) << std::dec;
        } else {
          output << static_cast<char>(ch);
        }
    }
  }
  return output.str();
}

std::optional<std::string> stringField(const JsonValue& object, const std::string& key) {
  const JsonValue* value = object.get(key);
  if (!value || value->kind != JsonValue::Kind::String) return std::nullopt;
  return value->string;
}

std::optional<std::uint32_t> uintField(const JsonValue& object, const std::string& key) {
  const JsonValue* value = object.get(key);
  if (!value || value->kind != JsonValue::Kind::Number || value->number < 0 || value->number > 4294967295.0) {
    return std::nullopt;
  }
  return static_cast<std::uint32_t>(value->number);
}

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) throw std::runtime_error("invalid UTF-8 path");
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length);
  return result;
}

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
  return result;
}

std::string windowsError(DWORD code) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                      nullptr, code, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  std::wstring message = length && buffer ? std::wstring(buffer, length) : L"Windows error " + std::to_wstring(code);
  if (buffer) LocalFree(buffer);
  while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) message.pop_back();
  return wideToUtf8(message);
}

std::string base64Encode(const std::vector<std::uint8_t>& bytes) {
  static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((bytes.size() + 2) / 3) * 4);
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    const std::uint32_t a = bytes[i];
    const std::uint32_t b = i + 1 < bytes.size() ? bytes[i + 1] : 0;
    const std::uint32_t c = i + 2 < bytes.size() ? bytes[i + 2] : 0;
    const std::uint32_t triple = (a << 16) | (b << 8) | c;
    output.push_back(alphabet[(triple >> 18) & 0x3F]);
    output.push_back(alphabet[(triple >> 12) & 0x3F]);
    output.push_back(i + 1 < bytes.size() ? alphabet[(triple >> 6) & 0x3F] : '=');
    output.push_back(i + 2 < bytes.size() ? alphabet[triple & 0x3F] : '=');
  }
  return output;
}

std::optional<std::vector<std::uint8_t>> base64Decode(const std::string& value) {
  static constexpr unsigned char invalid = 0xFF;
  std::array<unsigned char, 256> table{};
  table.fill(invalid);
  const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (std::size_t i = 0; i < alphabet.size(); ++i) table[static_cast<unsigned char>(alphabet[i])] = static_cast<unsigned char>(i);
  if (value.size() % 4 != 0) return std::nullopt;
  std::vector<std::uint8_t> output;
  output.reserve((value.size() / 4) * 3);
  for (std::size_t i = 0; i < value.size(); i += 4) {
    const bool pad2 = value[i + 2] == '=';
    const bool pad3 = value[i + 3] == '=';
    if (pad2 && !pad3) return std::nullopt;
    const unsigned char a = table[static_cast<unsigned char>(value[i])];
    const unsigned char b = table[static_cast<unsigned char>(value[i + 1])];
    const unsigned char c = pad2 ? 0 : table[static_cast<unsigned char>(value[i + 2])];
    const unsigned char d = pad3 ? 0 : table[static_cast<unsigned char>(value[i + 3])];
    if (a == invalid || b == invalid || c == invalid || d == invalid) return std::nullopt;
    const std::uint32_t triple = (static_cast<std::uint32_t>(a) << 18)
        | (static_cast<std::uint32_t>(b) << 12)
        | (static_cast<std::uint32_t>(c) << 6)
        | d;
    output.push_back(static_cast<std::uint8_t>((triple >> 16) & 0xFF));
    if (!pad2) output.push_back(static_cast<std::uint8_t>((triple >> 8) & 0xFF));
    if (!pad3) output.push_back(static_cast<std::uint8_t>(triple & 0xFF));
    if ((pad2 || pad3) && i + 4 != value.size()) return std::nullopt;
  }
  return output;
}

std::vector<std::wstring> findVersionedJLinkDlls() {
  const std::wstring root = L"C:\\Program Files\\SEGGER\\";
  WIN32_FIND_DATAW data{};
  HANDLE handle = FindFirstFileW((root + L"JLink_V*").c_str(), &data);
  if (handle == INVALID_HANDLE_VALUE) return {};
  std::vector<std::wstring> paths;
  do {
    if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      paths.push_back(root + data.cFileName + L"\\JLink_x64.dll");
    }
  } while (FindNextFileW(handle, &data));
  FindClose(handle);
  std::sort(paths.rbegin(), paths.rend());
  return paths;
}

class JLinkChannel {
 public:
  ~JLinkChannel() = default;  // Let process teardown unload the DLL; do not call JLINK_Close.

  std::string loadJLink(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (!module_) {
      const auto loadError = load(stringField(params, "dllPath").value_or(""));
      if (loadError) return error("JLinkDllLoadFailed", *loadError, started);
    }
    if (!symbolsReady_) return error("MissingJLinkSymbol", missingSymbol_, started);
    const int version = getDllVersion_();
    const std::string data = "{\"dllPath\":\"" + jsonEscape(loadedPath_) + "\",\"dllVersion\":" + std::to_string(version) + "}";
    return success(data, "J-Link DLL loaded", started);
  }

  std::string connect(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    const std::string device = stringField(params, "device").value_or("STM32F407VG");
    const std::string interfaceName = stringField(params, "interface").value_or("SWD");
    const std::uint32_t speed = uintField(params, "speedKHz").value_or(4000);
    if (!module_) {
      const std::string requestedPath = stringField(params, "dllPath").value_or("");
      const auto loadError = load(requestedPath);
      if (loadError) return error("JLinkDllLoadFailed", *loadError, started);
    }
    if (!symbolsReady_) return error("MissingJLinkSymbol", missingSymbol_, started);

    if (!wasOpened_) {
      const int result = open_();
      if (result < 0) return error("JLinkOpenFailed", "JLINK_Open returned " + std::to_string(result), started);
      wasOpened_ = true;
      std::cerr << "[JLinkHelper] JLINK_Open OK" << std::endl;
    }

    std::array<char, 512> commandOutput{};
    const std::string deviceCommand = "device " + device;
    int result = execCommand_(deviceCommand.c_str(), commandOutput.data(), static_cast<int>(commandOutput.size()));
    if (result < 0) return callError("JLINK_ExecCommand", result, started);
    result = setSpeed_(static_cast<int>(speed));
    if (result < 0) return callError("JLINK_SetSpeed", result, started);
    const int interfaceId = interfaceName == "JTAG" ? 0 : 1;
    result = selectInterface_(interfaceId);
    if (result < 0) return callError("JLINK_TIF_Select", result, started);
    result = connect_();
    if (result < 0) return error("JLinkConnectFailed", "JLINK_Connect returned " + std::to_string(result), started);
    std::cerr << "[JLinkHelper] JLINK_Connect OK" << std::endl;

    targetLinkProbeEnabled_ = false;
    if (readApDpRegister_) {
      std::uint32_t dpId = 0;
      const int probeResult = readApDpRegister_(0, 0, &dpId);
      targetLinkProbeEnabled_ = probeResult >= 0;
      std::cerr << "[JLinkHelper] SW-DP health probe "
                << (targetLinkProbeEnabled_ ? "enabled" : "unavailable")
                << " result=" << probeResult << " id=0x" << std::hex << dpId << std::dec << std::endl;
    }

    state_ = "Unknown";
    device_ = device;
    const int version = getDllVersion_();
    std::ostringstream data;
    data << "{\"device\":\"" << jsonEscape(device_) << "\",\"dllPath\":\"" << jsonEscape(loadedPath_)
         << "\",\"dllVersion\":" << version << "}";
    return success(data.str(), "connected", started);
  }

  std::string halt() {
    return simpleCall("JLINK_Halt", halt_, "Halted");
  }

  std::string run() {
    return simpleCall("JLINK_Go", go_, "Running");
  }

  std::string getState() {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    if (isConnected_ && isConnected_() == 0) {
      state_ = "Disconnected";
      return success("{\"state\":\"Disconnected\"}", "target disconnected", started);
    }
    if (getHwStatus_) {
      JLinkHwStatus status{};
      if (getHwStatus_(&status) == 0 && status.vTarget < kMinTargetVoltageMv) {
        state_ = "Disconnected";
        std::cerr << "[JLinkHelper] Target VTref lost: " << status.vTarget << " mV" << std::endl;
        return success("{\"state\":\"Disconnected\",\"targetVoltageMv\":" +
                           std::to_string(status.vTarget) + "}",
                       "target cable disconnected", started);
      }
    }
    if (targetLinkProbeEnabled_) {
      std::uint32_t dpId = 0;
      const int probeResult = readApDpRegister_(0, 0, &dpId);
      if (probeResult < 0) {
        state_ = "Error";
        std::cerr << "[JLinkHelper] SW-DP health probe failed: " << probeResult << std::endl;
        return error("TargetStateReadFailed", "SW-DP health probe returned " + std::to_string(probeResult), started,
                     "{\"function\":\"JLINK_CORESIGHT_ReadAPDPReg\",\"returnCode\":" +
                         std::to_string(probeResult) + "}");
      }
    }
    const int haltState = isHalted_();
    if (haltState < 0) {
      state_ = "Error";
      std::cerr << "[JLinkHelper] JLINK_IsHalted communication error: " << haltState << std::endl;
      return error("TargetStateReadFailed", "JLINK_IsHalted returned " + std::to_string(haltState), started,
                   "{\"function\":\"JLINK_IsHalted\",\"returnCode\":" + std::to_string(haltState) + "}");
    }
    state_ = haltState > 0 ? "Halted" : "Running";
    return success("{\"state\":\"" + state_ + "\"}", "target state read", started);
  }

  std::string reset() {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const int result = reset_();
    if (result < 0) return callError("JLINK_Reset", result, started);
    state_ = isHalted_() != 0 ? "Halted" : "Running";
    return success("{}", "target reset", started);
  }

  std::string step() {
    return simpleCall("JLINK_Step", step_, "Stepping");
  }

  std::string stepIntoInstruction() {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const auto elapsed = [&]() {
      return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    };
    const auto haltStarted = std::chrono::steady_clock::now();
    if (isHalted_() == 0) {
      const int haltResult = halt_();
      if (haltResult < 0) return callError("JLINK_Halt", haltResult, started);
    }
    state_ = "Halted";
    const auto haltMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - haltStarted).count();

    const auto readStarted = std::chrono::steady_clock::now();
    const int beforeResult = readRegister_(15);
    if (beforeResult == -1) return callError("JLINK_ReadReg(PC)", beforeResult, started);
    const std::uint32_t pcBefore = static_cast<std::uint32_t>(beforeResult);
    const auto readPcMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - readStarted).count();

    long long waitMs = 0;
    const auto waitUntilHalted = [&](std::uint32_t timeoutMs) {
      const auto waitStarted = std::chrono::steady_clock::now();
      const auto deadline = waitStarted + std::chrono::milliseconds(timeoutMs);
      while (std::chrono::steady_clock::now() < deadline) {
        if (isHalted_() != 0) {
          waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
          return true;
        }
        Sleep(1);
      }
      waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
      return false;
    };

    const auto executeStarted = std::chrono::steady_clock::now();
    const int stepResult = step_();
    const auto executeMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - executeStarted).count();
    bool operationOk = stepResult >= 0;
    if (operationOk && !waitUntilHalted(50)) {
      const int haltResult = halt_();
      operationOk = haltResult >= 0 && waitUntilHalted(50);
    }
    state_ = "Halted";
    const int afterResult = readRegister_(15);
    if (afterResult == -1) operationOk = false;
    const std::uint32_t pcAfter = afterResult == -1 ? pcBefore : static_cast<std::uint32_t>(afterResult);

    std::ostringstream diagnostics;
    diagnostics << "{\"pcBefore\":" << pcBefore << ",\"pcAfter\":" << pcAfter
                << ",\"classification\":\"instruction\",\"instructions\":1,\"cleanupOk\":true"
                << ",\"timings\":{\"haltMs\":" << haltMs << ",\"readPcMs\":" << readPcMs
                << ",\"decodeMs\":0,\"executeMs\":" << executeMs << ",\"waitMs\":" << waitMs
                << ",\"cleanupMs\":0,\"totalMs\":" << elapsed() << "}}";
    if (!operationOk) {
      return error("StepIntoInstructionFailed", "native instruction step failed and target was forced halted", started, diagnostics.str());
    }
    return success(diagnostics.str(), "native instruction step completed", started);
  }

  std::string stepIntoSourceLine(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const std::uint32_t lineStart = uintField(params, "lineStart").value_or(0);
    const std::uint32_t lineEnd = uintField(params, "lineEnd").value_or(0);
    const std::uint32_t maxInstructionSteps = std::max<std::uint32_t>(1,
        std::min<std::uint32_t>(uintField(params, "maxInstructionSteps").value_or(32), 64));
    const bool hasSourceRange = lineStart != 0 && lineEnd > lineStart;
    const auto elapsed = [&]() {
      return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    };

    const auto haltStarted = std::chrono::steady_clock::now();
    if (isHalted_() == 0) {
      const int haltResult = halt_();
      if (haltResult < 0) return callError("JLINK_Halt", haltResult, started);
    }
    state_ = "Halted";
    const auto haltMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - haltStarted).count();

    const auto readStarted = std::chrono::steady_clock::now();
    const int beforeResult = readRegister_(15);
    if (beforeResult == -1) return callError("JLINK_ReadReg(PC)", beforeResult, started);
    const std::uint32_t pcBefore = static_cast<std::uint32_t>(beforeResult);
    const auto readPcMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - readStarted).count();

    std::uint32_t pcAfter = pcBefore;
    std::uint32_t instructions = 0;
    long long decodeMs = 0;
    long long executeMs = 0;
    long long waitMs = 0;
    bool operationOk = true;
    bool enteredCall = false;
    bool limitReached = false;
    std::string classification = "sourceBoundary";
    std::string errorCode;
    std::string errorMessage;
    std::vector<std::string> trace;

    const auto waitUntilHalted = [&](std::uint32_t timeoutMs) {
      const auto waitStarted = std::chrono::steady_clock::now();
      const auto deadline = waitStarted + std::chrono::milliseconds(timeoutMs);
      while (std::chrono::steady_clock::now() < deadline) {
        if (isHalted_() != 0) {
          waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
          state_ = "Halted";
          return true;
        }
        Sleep(1);
      }
      waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
      return false;
    };

    const auto performSingleStep = [&]() {
      const auto executeStarted = std::chrono::steady_clock::now();
      const int stepResult = step_();
      executeMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - executeStarted).count();
      if (stepResult < 0) return false;
      state_ = "Stepping";
      if (waitUntilHalted(50)) return true;
      const int haltResult = halt_();
      return haltResult >= 0 && waitUntilHalted(50);
    };

    for (; instructions < maxInstructionSteps; ++instructions) {
      const int currentPcResult = readRegister_(15);
      if (currentPcResult == -1) {
        operationOk = false;
        errorCode = "StepIntoReadPcFailed";
        errorMessage = "failed to read PC during native source step into";
        break;
      }
      const std::uint32_t currentPc = static_cast<std::uint32_t>(currentPcResult);
      const auto decodeStarted = std::chrono::steady_clock::now();
      std::array<std::uint8_t, 4> bytes{};
      const int readResult = readMemory_(currentPc, static_cast<std::uint32_t>(bytes.size()), bytes.data());
      decodeMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - decodeStarted).count();
      if (readResult < 0) {
        operationOk = false;
        errorCode = "StepIntoReadInstructionFailed";
        errorMessage = "failed to read instruction during native source step into";
        break;
      }

      const std::uint16_t hw1 = static_cast<std::uint16_t>((bytes[1] << 8) | bytes[0]);
      const std::uint16_t hw2 = static_cast<std::uint16_t>((bytes[3] << 8) | bytes[2]);
      const bool is32Bit = (hw1 & 0xF800) == 0xE800 || (hw1 & 0xF800) == 0xF000 || (hw1 & 0xF800) == 0xF800;
      const bool isCall = (hw1 & 0xFF87) == 0x4780
          || ((hw1 & 0xF800) == 0xF000 && ((hw2 & 0xD000) == 0xD000 || (hw2 & 0xD000) == 0x8000));
      const bool isBranch = (!is32Bit && ((hw1 & 0xF000) == 0xD000 || (hw1 & 0xF800) == 0xE000 || (hw1 & 0xF500) == 0xB100))
          || (is32Bit && (hw1 & 0xF800) == 0xF000 && (hw2 & 0xC000) == 0x8000);
      const char* instructionClass = isCall ? "call" : (isBranch ? "branch" : "nonControl");
      std::ostringstream traceEntry;
      traceEntry << "{\"pc\":" << currentPc << ",\"classification\":\"" << instructionClass
                 << "\",\"call\":" << (isCall ? "true" : "false") << "}";
      trace.push_back(traceEntry.str());

      if (!performSingleStep()) {
        operationOk = false;
        errorCode = "StepIntoInstructionFailed";
        errorMessage = "native source step into failed and target was forced halted";
        break;
      }
      ++instructions;
      const int afterResult = readRegister_(15);
      if (afterResult == -1) {
        operationOk = false;
        errorCode = "StepIntoReadPcFailed";
        errorMessage = "failed to read PC after native source step into";
        break;
      }
      pcAfter = static_cast<std::uint32_t>(afterResult);
      if (isCall) {
        enteredCall = true;
        classification = "callEntered";
        break;
      }
      if (!hasSourceRange || pcAfter < lineStart || pcAfter >= lineEnd) {
        classification = hasSourceRange ? "sourceBoundary" : "instruction";
        break;
      }
      --instructions;
    }

    if (operationOk && !enteredCall && hasSourceRange && pcAfter >= lineStart && pcAfter < lineEnd
        && instructions >= maxInstructionSteps) {
      limitReached = true;
      classification = "instructionLimit";
    }
    state_ = "Halted";

    std::ostringstream diagnostics;
    diagnostics << "{\"pcBefore\":" << pcBefore << ",\"pcAfter\":" << pcAfter
                << ",\"classification\":\"" << classification << "\",\"phase\":\"sourceLine\""
                << ",\"instructions\":" << instructions << ",\"cleanupOk\":true"
                << ",\"enteredCall\":" << (enteredCall ? "true" : "false")
                << ",\"limitReached\":" << (limitReached ? "true" : "false") << ",\"trace\":[";
    for (std::size_t i = 0; i < trace.size(); ++i) {
      if (i != 0) diagnostics << ',';
      diagnostics << trace[i];
    }
    diagnostics << "]"
                << ",\"timings\":{\"haltMs\":" << haltMs << ",\"readPcMs\":" << readPcMs
                << ",\"decodeMs\":" << decodeMs << ",\"executeMs\":" << executeMs
                << ",\"waitMs\":" << waitMs << ",\"cleanupMs\":0,\"totalMs\":" << elapsed() << "}}";
    if (!operationOk) return error(errorCode, errorMessage, started, diagnostics.str());
    return success(diagnostics.str(), "native source line step into completed", started);
  }

  std::string stepOut(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const std::uint32_t functionStart = uintField(params, "functionStart").value_or(0);
    const std::uint32_t functionEnd = uintField(params, "functionEnd").value_or(0);
    const std::uint32_t waitTimeoutMs = std::min<std::uint32_t>(uintField(params, "waitTimeoutMs").value_or(1000), 2000);
    if (functionStart == 0 || functionEnd <= functionStart) {
      return error("StepOutFunctionRangeInvalid", "stepOut requires a non-empty current function range", started);
    }
    if (const JsonValue* snapshot = params.get("breakpoints"); snapshot && snapshot->kind == JsonValue::Kind::Object) {
      breakpoints_.fill(std::nullopt);
      for (int slot = 0; slot < kBreakpointSlots; ++slot) {
        const auto address = uintField(*snapshot, std::to_string(slot));
        if (address && *address != 0) breakpoints_[slot] = *address;
      }
    }
    const auto elapsed = [&]() {
      return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    };
    const auto haltStarted = std::chrono::steady_clock::now();
    if (isHalted_() == 0) {
      const int haltResult = halt_();
      if (haltResult < 0) return callError("JLINK_Halt", haltResult, started);
    }
    state_ = "Halted";
    const auto haltMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - haltStarted).count();

    const auto readStarted = std::chrono::steady_clock::now();
    const int pcResult = readRegister_(15);
    const int lrResult = readRegister_(14);
    const int spResult = readRegister_(13);
    const auto readPcMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - readStarted).count();
    if (pcResult == -1 || lrResult == -1 || spResult == -1) {
      return error("StepOutRegisterReadFailed", "failed to read PC, LR, or SP for step out", started);
    }
    const std::uint32_t pcBefore = static_cast<std::uint32_t>(pcResult);
    const std::uint32_t lr = static_cast<std::uint32_t>(lrResult);
    const std::uint32_t sp = static_cast<std::uint32_t>(spResult);
    if (pcBefore < functionStart || pcBefore >= functionEnd) {
      return error("StepOutPcOutsideFunction", "current PC is outside the supplied function range", started);
    }
    if ((lr & 0xFFFFFF00u) == 0xFFFFFF00u) {
      return error("StepOutExceptionFrameUnsupported", "LR is an exception-return token; stack-frame unwind is required", started);
    }
    if ((lr & 1u) == 0) {
      return error("StepOutInvalidLr", "LR does not contain a Thumb return address", started);
    }
    const std::uint32_t returnAddress = lr & ~1u;
    if (returnAddress >= functionStart && returnAddress < functionEnd) {
      return error("StepOutLrInsideFunction", "LR points inside the current function; saved-LR unwind is unavailable", started);
    }
    if (sp == 0 || (sp & 3u) != 0) {
      return error("StepOutInvalidStack", "SP is zero or not word-aligned", started);
    }
    std::array<std::uint8_t, 2> returnBytes{};
    if (readMemory_(returnAddress, static_cast<std::uint32_t>(returnBytes.size()), returnBytes.data()) < 0) {
      return error("StepOutReturnUnreadable", "LR return address is not readable executable memory", started);
    }

    int temporaryBreakpointSlot = -1;
    std::vector<std::pair<int, std::uint32_t>> clearedUserBreakpoints;
    bool cleanupOk = true;
    long long executeMs = 0;
    long long waitMs = 0;
    long long cleanupMs = 0;
    const auto cleanup = [&]() {
      const auto cleanupStarted = std::chrono::steady_clock::now();
      if (temporaryBreakpointSlot >= 0) {
        if (clearBreakpoint_(static_cast<std::uint32_t>(temporaryBreakpointSlot)) < 0) cleanupOk = false;
        breakpoints_[temporaryBreakpointSlot].reset();
        temporaryBreakpointSlot = -1;
      }
      for (const auto& breakpoint : clearedUserBreakpoints) {
        if (setBreakpoint_(static_cast<std::uint32_t>(breakpoint.first), breakpoint.second) < 0) cleanupOk = false;
        else breakpoints_[breakpoint.first] = breakpoint.second;
      }
      cleanupMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - cleanupStarted).count();
    };
    for (int slot = 0; slot < kBreakpointSlots; ++slot) {
      if (breakpoints_[slot] && *breakpoints_[slot] == pcBefore) {
        if (clearBreakpoint_(static_cast<std::uint32_t>(slot)) < 0) {
          cleanup();
          return error("StepOutCurrentBreakpointClearFailed", "failed to temporarily clear current user breakpoint", started);
        }
        clearedUserBreakpoints.emplace_back(slot, pcBefore);
        breakpoints_[slot].reset();
      }
    }

    std::string classification = "existingReturnBreakpoint";
    bool returnBreakpointExists = false;
    for (const auto& breakpoint : breakpoints_) {
      if (breakpoint && *breakpoint == returnAddress) returnBreakpointExists = true;
    }
    if (!returnBreakpointExists) {
      classification = "returnBreakpoint";
      for (int slot = 0; slot < kBreakpointSlots; ++slot) {
        if (!breakpoints_[slot]) {
          if (setBreakpoint_(static_cast<std::uint32_t>(slot), returnAddress) < 0) break;
          temporaryBreakpointSlot = slot;
          breakpoints_[slot] = returnAddress;
          break;
        }
      }
      if (temporaryBreakpointSlot < 0) {
        cleanup();
        return error("StepOutNoBreakpointSlot", "no hardware breakpoint slot is available for the return address", started);
      }
    }

    const auto waitUntilHalted = [&](std::uint32_t timeoutMs) {
      const auto waitStarted = std::chrono::steady_clock::now();
      const auto deadline = waitStarted + std::chrono::milliseconds(timeoutMs);
      while (std::chrono::steady_clock::now() < deadline) {
        if (isHalted_() != 0) {
          waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
          return true;
        }
        Sleep(1);
      }
      waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
      return false;
    };
    const auto executeStarted = std::chrono::steady_clock::now();
    const int goResult = go_();
    executeMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - executeStarted).count();
    bool operationOk = goResult >= 0 && waitUntilHalted(waitTimeoutMs);
    if (!operationOk) {
      const int haltResult = halt_();
      if (haltResult >= 0) waitUntilHalted(50);
    }
    state_ = "Halted";
    const int afterResult = readRegister_(15);
    const std::uint32_t pcAfter = afterResult == -1 ? pcBefore : static_cast<std::uint32_t>(afterResult);
    if (operationOk && pcAfter != returnAddress) classification = "userBreakpoint";
    cleanup();

    std::ostringstream diagnostics;
    diagnostics << "{\"pcBefore\":" << pcBefore << ",\"pcAfter\":" << pcAfter << ",\"lr\":" << lr
                << ",\"sp\":" << sp << ",\"returnAddress\":" << returnAddress
                << ",\"classification\":\"" << classification << "\",\"instructions\":0"
                << ",\"cleanupOk\":" << (cleanupOk ? "true" : "false")
                << ",\"timings\":{\"haltMs\":" << haltMs << ",\"readPcMs\":" << readPcMs
                << ",\"decodeMs\":0,\"executeMs\":" << executeMs << ",\"waitMs\":" << waitMs
                << ",\"cleanupMs\":" << cleanupMs << ",\"totalMs\":" << elapsed() << "}}";
    if (!cleanupOk) return error("StepCleanupFailed", "step out completed but breakpoint cleanup failed", started, diagnostics.str());
    if (!operationOk) return error("StepOutTimeout", "target did not halt at the return breakpoint before timeout", started, diagnostics.str());
    return success(diagnostics.str(), "native step out completed", started);
  }

  std::string stepOverSourceLine(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const std::uint32_t lineStart = uintField(params, "lineStart").value_or(0);
    const std::uint32_t lineEnd = uintField(params, "lineEnd").value_or(0);
    const std::uint32_t waitTimeoutMs = std::min<std::uint32_t>(uintField(params, "waitTimeoutMs").value_or(1000), 2000);
    const std::uint32_t maxInstructionSteps = std::min<std::uint32_t>(uintField(params, "maxInstructionSteps").value_or(128), 256);
    if (const JsonValue* breakpointSnapshot = params.get("breakpoints");
        breakpointSnapshot && breakpointSnapshot->kind == JsonValue::Kind::Object) {
      breakpoints_.fill(std::nullopt);
      for (int slot = 0; slot < kBreakpointSlots; ++slot) {
        const auto address = uintField(*breakpointSnapshot, std::to_string(slot));
        if (address && *address != 0) breakpoints_[slot] = *address;
      }
    }
    const auto elapsed = [&]() {
      return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    };

    const auto haltStarted = std::chrono::steady_clock::now();
    if (isHalted_() == 0) {
      const int haltResult = halt_();
      if (haltResult < 0) return callError("JLINK_Halt", haltResult, started);
    }
    state_ = "Halted";
    const auto haltMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - haltStarted).count();

    const auto readStarted = std::chrono::steady_clock::now();
    const int pcResult = readRegister_(15);
    if (pcResult == -1) return callError("JLINK_ReadReg(PC)", pcResult, started);
    const std::uint32_t pcBefore = static_cast<std::uint32_t>(pcResult);
    const auto readPcMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - readStarted).count();

    std::string classification = "singleStep";
    std::uint32_t pcAfter = pcBefore;
    std::uint32_t instructions = 0;
    long long decodeMs = 0;
    long long executeMs = 0;
    long long waitMs = 0;
    long long cleanupMs = 0;
    std::vector<int> temporaryBreakpointSlots;
    std::uint32_t temporaryBreakpointCount = 0;
    int clearedUserBreakpointSlot = -1;
    std::uint32_t clearedUserBreakpointAddress = 0;
    bool cleanupOk = true;

    const auto cleanupBreakpoints = [&]() {
      const auto cleanupStarted = std::chrono::steady_clock::now();
      for (const int slot : temporaryBreakpointSlots) {
        if (clearBreakpoint_(static_cast<std::uint32_t>(slot)) < 0) cleanupOk = false;
        breakpoints_[slot].reset();
      }
      temporaryBreakpointSlots.clear();
      if (clearedUserBreakpointSlot >= 0) {
        if (setBreakpoint_(static_cast<std::uint32_t>(clearedUserBreakpointSlot), clearedUserBreakpointAddress) < 0) cleanupOk = false;
        else breakpoints_[clearedUserBreakpointSlot] = clearedUserBreakpointAddress;
        clearedUserBreakpointSlot = -1;
      }
      cleanupMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - cleanupStarted).count();
    };

    const auto waitUntilHalted = [&](std::uint32_t timeoutMs) {
      const auto waitStarted = std::chrono::steady_clock::now();
      const auto deadline = waitStarted + std::chrono::milliseconds(timeoutMs);
      while (std::chrono::steady_clock::now() < deadline) {
        if (isHalted_() != 0) {
          waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
          state_ = "Halted";
          return true;
        }
        Sleep(1);
      }
      waitMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - waitStarted).count();
      return false;
    };

    const auto instructionInfo = [&](std::uint32_t address, bool& isCall, bool& isBranch, std::uint32_t& width) {
      const auto decodeStarted = std::chrono::steady_clock::now();
      std::array<std::uint8_t, 4> bytes{};
      const int readResult = readMemory_(address, static_cast<std::uint32_t>(bytes.size()), bytes.data());
      decodeMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - decodeStarted).count();
      if (readResult < 0) return false;
      const std::uint16_t hw1 = static_cast<std::uint16_t>((bytes[1] << 8) | bytes[0]);
      const std::uint16_t hw2 = static_cast<std::uint16_t>((bytes[3] << 8) | bytes[2]);
      const bool is32Bit = (hw1 & 0xF800) == 0xE800 || (hw1 & 0xF800) == 0xF000 || (hw1 & 0xF800) == 0xF800;
      width = is32Bit ? 4u : 2u;
      isCall = (hw1 & 0xFF87) == 0x4780
          || ((hw1 & 0xF800) == 0xF000 && ((hw2 & 0xD000) == 0xD000 || (hw2 & 0xD000) == 0x8000));
      isBranch = (!is32Bit && ((hw1 & 0xF000) == 0xD000 || (hw1 & 0xF800) == 0xE000 || (hw1 & 0xF500) == 0xB100))
          || (is32Bit && (hw1 & 0xF800) == 0xF000 && (hw2 & 0xC000) == 0x8000);
      return true;
    };

    const auto performSingleStep = [&]() {
      const auto executeStarted = std::chrono::steady_clock::now();
      const int stepResult = step_();
      executeMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - executeStarted).count();
      if (stepResult < 0) return false;
      state_ = "Stepping";
      if (!waitUntilHalted(50)) {
        const int haltResult = halt_();
        if (haltResult < 0) return false;
        if (!waitUntilHalted(50)) return false;
      }
      return true;
    };

    const auto runToReturnAddress = [&](std::uint32_t currentPc, std::uint32_t returnAddress) {
      for (int slot = 0; slot < kBreakpointSlots; ++slot) {
        if (breakpoints_[slot] && *breakpoints_[slot] == currentPc) {
          if (clearBreakpoint_(static_cast<std::uint32_t>(slot)) < 0) return false;
          breakpoints_[slot].reset();
          const auto temporary = std::find(temporaryBreakpointSlots.begin(), temporaryBreakpointSlots.end(), slot);
          if (temporary != temporaryBreakpointSlots.end()) {
            temporaryBreakpointSlots.erase(temporary);
          } else {
            clearedUserBreakpointSlot = slot;
            clearedUserBreakpointAddress = currentPc;
          }
          break;
        }
      }

      bool returnBreakpointExists = false;
      for (const auto& breakpoint : breakpoints_) {
        if (breakpoint && *breakpoint == returnAddress) {
          returnBreakpointExists = true;
          break;
        }
      }
      if (!returnBreakpointExists) {
        bool installedTemporaryBreakpoint = false;
        for (int slot = 0; slot < kBreakpointSlots; ++slot) {
          if (!breakpoints_[slot]) {
            if (setBreakpoint_(static_cast<std::uint32_t>(slot), returnAddress) < 0) return false;
            temporaryBreakpointSlots.push_back(slot);
            ++temporaryBreakpointCount;
            breakpoints_[slot] = returnAddress;
            installedTemporaryBreakpoint = true;
            break;
          }
        }
        if (!installedTemporaryBreakpoint) return false;
      }

      const auto executeStarted = std::chrono::steady_clock::now();
      const int goResult = go_();
      executeMs += std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - executeStarted).count();
      if (goResult < 0) return false;
      state_ = "Running";
      if (waitUntilHalted(waitTimeoutMs)) {
        const int stoppedPcResult = readRegister_(15);
        if (stoppedPcResult == -1) return false;
        const std::uint32_t stoppedPc = static_cast<std::uint32_t>(stoppedPcResult);
        if (stoppedPc != returnAddress) return true;
        // A return-address breakpoint is hit with the PC still pointing at
        // that breakpoint. Remove only the temporary slot before the outer
        // loop issues JLINK_Step; stepping while the breakpoint remains at
        // the current PC can repeatedly stop at the same address.
        for (auto temporary = temporaryBreakpointSlots.begin();
             temporary != temporaryBreakpointSlots.end(); ++temporary) {
          const int slot = *temporary;
          if (!breakpoints_[slot] || *breakpoints_[slot] != returnAddress) continue;
          if (clearBreakpoint_(static_cast<std::uint32_t>(slot)) < 0) return false;
          breakpoints_[slot].reset();
          temporaryBreakpointSlots.erase(temporary);
          break;
        }
        return true;
      }
      const int haltResult = halt_();
      if (haltResult < 0) return false;
      waitUntilHalted(50);
      return false;
    };

    bool operationOk = true;
    std::string errorCode;
    std::string errorMessage;
    for (; instructions < maxInstructionSteps; ++instructions) {
      const int currentPcResult = readRegister_(15);
      if (currentPcResult == -1) {
        operationOk = false;
        errorCode = "StepReadPcFailed";
        errorMessage = "failed to read PC during native step over";
        break;
      }
      const std::uint32_t currentPc = static_cast<std::uint32_t>(currentPcResult);
      bool isCall = false;
      bool isBranch = false;
      std::uint32_t width = 2;
      if (!instructionInfo(currentPc, isCall, isBranch, width)) {
        operationOk = false;
        errorCode = "StepReadInstructionFailed";
        errorMessage = "failed to read instruction during native step over";
        break;
      }

      classification = isCall ? "callReturnBreakpoint" : (isBranch ? "branchSingleStep" : "singleStep");
      if (isCall) {
        if (!runToReturnAddress(currentPc, currentPc + width)) {
          operationOk = false;
          errorCode = "StepReturnBreakpointFailed";
          errorMessage = "native call step-over did not reach the return address";
          break;
        }
      } else if (!performSingleStep()) {
        operationOk = false;
        errorCode = "StepInstructionFailed";
        errorMessage = "native single instruction step failed";
        break;
      }

      const int afterResult = readRegister_(15);
      if (afterResult == -1) {
        operationOk = false;
        errorCode = "StepReadPcFailed";
        errorMessage = "failed to read PC after native step";
        break;
      }
      pcAfter = static_cast<std::uint32_t>(afterResult);
      if (lineStart == 0 || lineEnd <= lineStart || pcAfter < lineStart || pcAfter >= lineEnd) {
        ++instructions;
        break;
      }
    }

    if (operationOk && instructions >= maxInstructionSteps && lineEnd > lineStart && pcAfter >= lineStart && pcAfter < lineEnd) {
      operationOk = false;
      errorCode = "StepInstructionLimit";
      errorMessage = "native step over remained on the source line after the instruction limit";
    }
    cleanupBreakpoints();
    state_ = "Halted";

    std::ostringstream diagnostics;
    diagnostics << "{\"pcBefore\":" << pcBefore << ",\"pcAfter\":" << pcAfter
                << ",\"classification\":\"" << classification << "\",\"instructions\":" << instructions
                << ",\"temporaryBreakpointCount\":" << temporaryBreakpointCount
                << ",\"cleanupOk\":" << (cleanupOk ? "true" : "false")
                << ",\"timings\":{\"haltMs\":" << haltMs << ",\"readPcMs\":" << readPcMs
                << ",\"decodeMs\":" << decodeMs << ",\"executeMs\":" << executeMs
                << ",\"waitMs\":" << waitMs << ",\"cleanupMs\":" << cleanupMs
                << ",\"totalMs\":" << elapsed() << "}}";
    if (!cleanupOk) {
      return error("StepCleanupFailed", "native step completed but breakpoint cleanup failed", started, diagnostics.str());
    }
    if (!operationOk) return error(errorCode, errorMessage, started, diagnostics.str());
    return success(diagnostics.str(), "native source line step completed", started);
  }

  std::string readRegister(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const auto index = uintField(params, "index");
    if (!index || *index > 255) return error("ProtocolError", "readRegister requires index 0..255", started);
    const int result = readRegister_(static_cast<int>(*index));
    if (result == -1) return callError("JLINK_ReadReg", result, started);
    const std::uint32_t value = static_cast<std::uint32_t>(result);
    return success("{\"index\":" + std::to_string(*index) + ",\"value\":" + std::to_string(value) + "}", "register read", started);
  }

  std::string readMemory(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const auto address = uintField(params, "address");
    const auto size = uintField(params, "size");
    if (!address || !size || *size == 0 || *size > 1024 * 1024) {
      return error("ProtocolError", "readMemory requires address and size 1..1048576", started);
    }
    std::vector<std::uint8_t> bytes(*size);
    const int result = readMemory_(*address, *size, bytes.data());
    if (result < 0) return callError("JLINK_ReadMem", result, started);
    const std::string data = "{\"address\":" + std::to_string(*address) + ",\"bytesBase64\":\"" + base64Encode(bytes) + "\"}";
    return success(data, "memory read", started);
  }

  std::string readMemoryBatch(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const JsonValue* reads = params.get("reads");
    if (!reads || reads->kind != JsonValue::Kind::Array || reads->array.size() > 256) {
      return error("ProtocolError", "readMemoryBatch requires at most 256 reads", started);
    }
    std::size_t totalBytes = 0;
    std::ostringstream data;
    data << "{\"reads\":[";
    for (std::size_t index = 0; index < reads->array.size(); ++index) {
      const JsonValue& item = reads->array[index];
      const auto address = uintField(item, "address");
      const auto size = uintField(item, "size");
      if (item.kind != JsonValue::Kind::Object || !address || !size || *size == 0 || *size > 1024 * 1024) {
        return error("ProtocolError", "readMemoryBatch item requires address and size", started);
      }
      totalBytes += *size;
      if (totalBytes > 1024 * 1024) return error("ProtocolError", "readMemoryBatch exceeds 1048576 bytes", started);
      std::vector<std::uint8_t> bytes(*size);
      const int result = readMemory_(*address, *size, bytes.data());
      if (result < 0) return callError("JLINK_ReadMem", result, started);
      if (index != 0) data << ',';
      data << "{\"address\":" << *address << ",\"bytesBase64\":\"" << base64Encode(bytes) << "\"}";
    }
    data << "]}";
    return success(data.str(), "memory batch read", started);
  }

  std::string writeMemory(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const auto address = uintField(params, "address");
    const auto encoded = stringField(params, "bytesBase64");
    if (!address || !encoded) return error("ProtocolError", "writeMemory requires address and bytesBase64", started);
    const auto bytes = base64Decode(*encoded);
    if (!bytes || bytes->empty() || bytes->size() > 1024 * 1024) {
      return error("ProtocolError", "writeMemory bytesBase64 is invalid or empty", started);
    }
    const int result = writeMemory_(*address, static_cast<std::uint32_t>(bytes->size()), bytes->data());
    if (result < 0) return callError("JLINK_WriteMem", result, started);
    if (static_cast<std::size_t>(result) != bytes->size()) {
      return error("JLinkShortWrite", "JLINK_WriteMem wrote fewer bytes than requested", started);
    }
    return success("{\"address\":" + std::to_string(*address) + ",\"bytesWritten\":" + std::to_string(result) + "}",
                   "memory written", started);
  }

  std::string setBreakpoint(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const auto address = uintField(params, "address");
    if (!address) return error("ProtocolError", "setBreakpoint requires address", started);
    int slot = -1;
    if (const auto preferred = uintField(params, "preferredSlot"); preferred && *preferred < kBreakpointSlots && !breakpoints_[*preferred]) {
      slot = static_cast<int>(*preferred);
    } else {
      for (int i = 0; i < kBreakpointSlots; ++i) {
        if (!breakpoints_[i]) { slot = i; break; }
      }
    }
    if (slot < 0) return error("NoBreakpointSlot", "all six prototype breakpoint slots are occupied", started);
    const int result = setBreakpoint_(static_cast<std::uint32_t>(slot), *address);
    if (result < 0) return callError("JLINK_SetBP", result, started);
    breakpoints_[slot] = *address;
    return success("{\"id\":" + std::to_string(slot) + ",\"address\":" + std::to_string(*address) + "}", "breakpoint set", started);
  }

  std::string clearBreakpoint(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const auto id = uintField(params, "id");
    if (!id || *id >= kBreakpointSlots) return error("ProtocolError", "clearBreakpoint requires id 0..5", started);
    const bool wasRunning = isHalted_() == 0;
    if (wasRunning) {
      const int haltResult = halt_();
      if (haltResult < 0) return callError("JLINK_Halt", haltResult, started);
    }
    const int result = clearBreakpoint_(*id);
    if (wasRunning) go_();
    if (result < 0) return callError("JLINK_ClrBP", result, started);
    breakpoints_[*id].reset();
    return success("{\"id\":" + std::to_string(*id) + "}", "breakpoint cleared", started);
  }

  std::string clearAllBreakpoints() {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const bool wasRunning = isHalted_() == 0;
    if (wasRunning && halt_() < 0) return callError("JLINK_Halt", -1, started);
    for (std::uint32_t slot = 0; slot < kBreakpointSlots; ++slot) {
      const int result = clearBreakpoint_(slot);
      if (result < 0) {
        if (wasRunning) go_();
        return callError("JLINK_ClrBP", result, started);
      }
      breakpoints_[slot].reset();
    }
    if (wasRunning && go_() < 0) return callError("JLINK_Go", -1, started);
    state_ = wasRunning ? "Running" : "Halted";
    return success("{}", "all breakpoints cleared", started);
  }

  std::string startRtt(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    if (!rttControl_) return error("UnsupportedCapability", "J-Link DLL does not export RTT control", started);
    std::array<std::uint8_t, 16> config{};
    void* configPointer = nullptr;
    if (const auto address = uintField(params, "controlBlockAddress"); address && *address != 0) {
      config[0] = static_cast<std::uint8_t>(*address & 0xFF);
      config[1] = static_cast<std::uint8_t>((*address >> 8) & 0xFF);
      config[2] = static_cast<std::uint8_t>((*address >> 16) & 0xFF);
      config[3] = static_cast<std::uint8_t>((*address >> 24) & 0xFF);
      configPointer = config.data();
    }
    const int result = rttControl_(0, configPointer);
    if (result < 0) return callError("JLINK_RTTERMINAL_Control(start)", result, started);
    rttStarted_ = true;
    rttReadCalls_ = 0;
    rttReceivedBytes_ = 0;
    rttEmptyReads_ = 0;
    rttReadErrors_ = 0;
    return success("{}", "RTT started", started);
  }

  std::string stopRtt() {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    if (!rttControl_) return error("UnsupportedCapability", "J-Link DLL does not export RTT control", started);
    if (rttStarted_) {
      const int result = rttControl_(1, nullptr);
      if (result < 0) return callError("JLINK_RTTERMINAL_Control(stop)", result, started);
    }
    rttStarted_ = false;
    return success("{}", "RTT stopped", started);
  }

  std::string readRtt(const JsonValue& params) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    if (!rttRead_) return error("UnsupportedCapability", "J-Link DLL does not export RTT read", started);
    const auto bufferIndex = uintField(params, "bufferIndex");
    const auto size = uintField(params, "size");
    if (!bufferIndex || !size || *size == 0 || *size > 1024 * 1024) {
      return error("ProtocolError", "readRtt requires bufferIndex and size", started);
    }
    if (!rttStarted_) return error("NotStarted", "RTT must be started before read", started);
    rttReadCalls_++;
    std::vector<std::uint8_t> bytes(*size);
    const int result = rttRead_(*bufferIndex, bytes.data(), *size);
    if (result < 0) {
      rttReadErrors_++;
      return callError("JLINK_RTTERMINAL_Read", result, started);
    }
    bytes.resize(static_cast<std::size_t>(result));
    rttReceivedBytes_ += static_cast<std::uint64_t>(result);
    if (result == 0) rttEmptyReads_++;
    std::ostringstream data;
    data << "{\"bytesBase64\":\"" << base64Encode(bytes) << "\",\"stats\":{"
         << "\"requestedSize\":" << *size
         << ",\"returnedSize\":" << result
         << ",\"empty\":" << (result == 0 ? "true" : "false")
         << ",\"readCalls\":" << rttReadCalls_
         << ",\"receivedBytes\":" << rttReceivedBytes_
         << ",\"emptyReads\":" << rttEmptyReads_
         << ",\"readErrors\":" << rttReadErrors_ << "}}";
    return success(data.str(), "RTT read", started);
  }

  std::string disconnect() {
    const auto started = std::chrono::steady_clock::now();
    if (state_ == "Disconnected") return success("{}", "already disconnected", started);
    if (rttStarted_ && rttControl_) rttControl_(1, nullptr);
    rttStarted_ = false;
    halt_();
    for (std::uint32_t slot = 0; slot < kBreakpointSlots; ++slot) {
      clearBreakpoint_(slot);
      breakpoints_[slot].reset();
    }
    state_ = "Disconnected";
    const int runResult = go_();
    if (runResult < 0) return callError("JLINK_Go", runResult, started);
    return success("{}", "disconnected and target resumed", started);
  }

  const std::string& state() const { return state_; }

 private:
  struct JLinkHwStatus {
    std::uint16_t vTarget;
    std::uint8_t tck;
    std::uint8_t tdi;
    std::uint8_t tdo;
    std::uint8_t tms;
    std::uint8_t tres;
    std::uint8_t trst;
  };

  static constexpr std::uint16_t kMinTargetVoltageMv = 1000;
  using NoArgFn = int(__cdecl*)();
  using ReadApDpRegisterFn = int(__cdecl*)(std::uint8_t, std::uint8_t, std::uint32_t*);
  using GetHwStatusFn = int(__cdecl*)(JLinkHwStatus*);
  using ExecCommandFn = int(__cdecl*)(const char*, char*, int);
  using IntArgFn = int(__cdecl*)(int);
  using ReadMemoryFn = int(__cdecl*)(std::uint32_t, std::uint32_t, void*);
  using WriteMemoryFn = int(__cdecl*)(std::uint32_t, std::uint32_t, const void*);
  using BreakpointFn = int(__cdecl*)(std::uint32_t, std::uint32_t);
  using ClearBreakpointFn = int(__cdecl*)(std::uint32_t);
  using RttControlFn = int(__cdecl*)(std::uint32_t, void*);
  using RttReadFn = int(__cdecl*)(std::uint32_t, void*, std::uint32_t);

  template <typename T>
  T resolve(const char* primary, const char* alternate = nullptr) {
    FARPROC address = GetProcAddress(module_, primary);
    if (!address && alternate) address = GetProcAddress(module_, alternate);
    if (!address && missingSymbol_.empty()) missingSymbol_ = std::string("missing ") + primary;
    return reinterpret_cast<T>(address);
  }

  template <typename T>
  T resolveOptional(const char* primary, const char* alternate = nullptr) {
    FARPROC address = GetProcAddress(module_, primary);
    if (!address && alternate) address = GetProcAddress(module_, alternate);
    return reinterpret_cast<T>(address);
  }

  std::optional<std::string> load(const std::string& requestedPath) {
    std::vector<std::wstring> candidates;
    if (!requestedPath.empty()) candidates.push_back(utf8ToWide(requestedPath));
    const auto versionedDlls = findVersionedJLinkDlls();
    candidates.insert(candidates.end(), versionedDlls.begin(), versionedDlls.end());
    candidates.push_back(L"C:\\Program Files\\SEGGER\\Ozone\\JLink_x64.dll");
    candidates.push_back(L"JLink_x64.dll");

    DWORD lastError = ERROR_FILE_NOT_FOUND;
    for (const std::wstring& candidate : candidates) {
      module_ = LoadLibraryW(candidate.c_str());
      if (module_) {
        loadedPath_ = wideToUtf8(candidate);
        break;
      }
      lastError = GetLastError();
    }
    if (!module_) return "LoadLibraryW failed: " + windowsError(lastError);

    getDllVersion_ = resolve<NoArgFn>("JLINK_GetDLLVersion", "JLINKARM_GetDLLVersion");
    open_ = resolve<NoArgFn>("JLINK_Open", "JLINKARM_Open");
    execCommand_ = resolve<ExecCommandFn>("JLINK_ExecCommand", "JLINKARM_ExecCommand");
    setSpeed_ = resolve<IntArgFn>("JLINK_SetSpeed", "JLINKARM_SetSpeed");
    selectInterface_ = resolve<IntArgFn>("JLINK_TIF_Select", "JLINKARM_TIF_Select");
    connect_ = resolve<NoArgFn>("JLINK_Connect", "JLINKARM_Connect");
    halt_ = resolve<NoArgFn>("JLINK_Halt", "JLINKARM_Halt");
    go_ = resolve<NoArgFn>("JLINK_Go", "JLINKARM_Go");
    step_ = resolve<NoArgFn>("JLINK_Step", "JLINKARM_Step");
    reset_ = resolve<NoArgFn>("JLINK_Reset", "JLINKARM_Reset");
    readRegister_ = resolve<IntArgFn>("JLINK_ReadReg", "JLINKARM_ReadReg");
    isHalted_ = resolve<NoArgFn>("JLINK_IsHalted", "JLINKARM_IsHalted");
    isConnected_ = resolveOptional<NoArgFn>("JLINK_IsConnected", "JLINKARM_IsConnected");
    getHwStatus_ = resolveOptional<GetHwStatusFn>("JLINK_GetHWStatus", "JLINKARM_GetHWStatus");
    readApDpRegister_ = resolveOptional<ReadApDpRegisterFn>(
        "JLINK_CORESIGHT_ReadAPDPReg", "JLINKARM_CORESIGHT_ReadAPDPReg");
    readMemory_ = resolve<ReadMemoryFn>("JLINK_ReadMem", "JLINKARM_ReadMem");
    writeMemory_ = resolve<WriteMemoryFn>("JLINK_WriteMem", "JLINKARM_WriteMem");
    setBreakpoint_ = resolve<BreakpointFn>("JLINK_SetBP", "JLINKARM_SetBP");
    clearBreakpoint_ = resolve<ClearBreakpointFn>("JLINK_ClrBP", "JLINKARM_ClrBP");
    rttControl_ = resolveOptional<RttControlFn>("JLINK_RTTERMINAL_Control");
    rttRead_ = resolveOptional<RttReadFn>("JLINK_RTTERMINAL_Read");
    symbolsReady_ = missingSymbol_.empty();
    return std::nullopt;
  }

  std::string simpleCall(const std::string& functionName, NoArgFn function, const std::string& nextState) {
    const auto started = std::chrono::steady_clock::now();
    if (const auto unavailable = requireConnected(started)) return *unavailable;
    const int result = function();
    if (result < 0) return callError(functionName, result, started);
    state_ = nextState;
    return success("{}", functionName + " completed", started);
  }

  std::optional<std::string> requireConnected(const std::chrono::steady_clock::time_point& started) const {
    if (!module_ || !symbolsReady_ || state_ == "Disconnected") {
      return error("JLinkNotConnected", "connect must succeed before target commands", started);
    }
    return std::nullopt;
  }

  std::string callError(const std::string& functionName, int result, const std::chrono::steady_clock::time_point& started) const {
    return error("JLinkCallFailed", functionName + " returned " + std::to_string(result), started,
                 "{\"function\":\"" + jsonEscape(functionName) + "\",\"returnCode\":" + std::to_string(result) + "}");
  }

  std::string success(const std::string& data, const std::string& message, const std::chrono::steady_clock::time_point& started) const {
    return resultPrefix(true, message, started) + ",\"data\":" + data + "}";
  }

  std::string error(const std::string& code, const std::string& message, const std::chrono::steady_clock::time_point& started,
                    const std::string& diagnostics = "{}") const {
    return resultPrefix(false, message, started) + ",\"errorCode\":\"" + jsonEscape(code) + "\",\"diagnostics\":" + diagnostics + "}";
  }

  std::string resultPrefix(bool ok, const std::string& message, const std::chrono::steady_clock::time_point& started) const {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    return std::string("{\"ok\":") + (ok ? "true" : "false") + ",\"message\":\"" + jsonEscape(message) +
           "\",\"targetState\":\"" + state_ + "\",\"elapsedMs\":" + std::to_string(elapsed);
  }

  HMODULE module_ = nullptr;
  bool symbolsReady_ = false;
  bool wasOpened_ = false;
  bool rttStarted_ = false;
  std::uint64_t rttReadCalls_ = 0;
  std::uint64_t rttReceivedBytes_ = 0;
  std::uint64_t rttEmptyReads_ = 0;
  std::uint64_t rttReadErrors_ = 0;
  bool targetLinkProbeEnabled_ = false;
  std::string missingSymbol_;
  std::string loadedPath_;
  std::string device_;
  std::string state_ = "Disconnected";
  std::array<std::optional<std::uint32_t>, kBreakpointSlots> breakpoints_{};

  NoArgFn getDllVersion_ = nullptr;
  NoArgFn open_ = nullptr;
  ExecCommandFn execCommand_ = nullptr;
  IntArgFn setSpeed_ = nullptr;
  IntArgFn selectInterface_ = nullptr;
  NoArgFn connect_ = nullptr;
  NoArgFn halt_ = nullptr;
  NoArgFn go_ = nullptr;
  NoArgFn step_ = nullptr;
  NoArgFn reset_ = nullptr;
  IntArgFn readRegister_ = nullptr;
  NoArgFn isHalted_ = nullptr;
  NoArgFn isConnected_ = nullptr;
  GetHwStatusFn getHwStatus_ = nullptr;
  ReadApDpRegisterFn readApDpRegister_ = nullptr;
  ReadMemoryFn readMemory_ = nullptr;
  WriteMemoryFn writeMemory_ = nullptr;
  BreakpointFn setBreakpoint_ = nullptr;
  ClearBreakpointFn clearBreakpoint_ = nullptr;
  RttControlFn rttControl_ = nullptr;
  RttReadFn rttRead_ = nullptr;
};

std::string responseEnvelope(const JsonValue& request, const std::string& result) {
  const JsonValue* id = request.get("id");
  std::string idJson = "null";
  if (id && id->kind == JsonValue::Kind::Number) idJson = std::to_string(static_cast<std::uint64_t>(id->number));
  return "{\"id\":" + idJson + ",\"result\":" + result + "}";
}

std::string protocolError(const JsonValue* request, const std::string& message, const std::string& state) {
  std::string idJson = "null";
  if (request) {
    const JsonValue* id = request->get("id");
    if (id && id->kind == JsonValue::Kind::Number) idJson = std::to_string(static_cast<std::uint64_t>(id->number));
  }
  return "{\"id\":" + idJson + ",\"result\":{\"ok\":false,\"message\":\"" + jsonEscape(message) +
         "\",\"targetState\":\"" + state + "\",\"elapsedMs\":0,\"errorCode\":\"ProtocolError\",\"diagnostics\":{}}}";
}

}  // namespace

int main() {
  SetConsoleOutputCP(CP_UTF8);
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  JLinkChannel channel;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    try {
      const JsonValue request = JsonParser(line).parse();
      if (request.kind != JsonValue::Kind::Object) {
        std::cout << protocolError(&request, "request must be an object", channel.state()) << '\n' << std::flush;
        continue;
      }
      const auto method = stringField(request, "method");
      if (!method) {
        std::cout << protocolError(&request, "request.method must be a string", channel.state()) << '\n' << std::flush;
        continue;
      }
      JsonValue emptyParams;
      emptyParams.kind = JsonValue::Kind::Object;
      const JsonValue* params = request.get("params");
      if (!params) params = &emptyParams;
      if (params->kind != JsonValue::Kind::Object) {
        std::cout << protocolError(&request, "request.params must be an object", channel.state()) << '\n' << std::flush;
        continue;
      }

      std::string result;
      if (*method == "hello") {
        const int clientProtocol = static_cast<int>(uintField(*params, "clientProtocol").value_or(0));
        if (clientProtocol != kProtocolVersion) {
          result = "{\"ok\":false,\"message\":\"protocol version mismatch\",\"targetState\":\"Disconnected\",\"elapsedMs\":0,"
                   "\"errorCode\":\"ProtocolVersionMismatch\",\"diagnostics\":{\"helperProtocol\":2}}";
        } else {
          result = "{\"ok\":true,\"message\":\"orbit-jlink-helper ready\",\"targetState\":\"Disconnected\",\"elapsedMs\":0,"
                   "\"data\":{\"protocol\":2,\"helperVersion\":\"0.2.0\",\"platform\":\"win32-x64\"," 
                   "\"capabilities\":[\"basicDebug\",\"readRegister\",\"readMemory\",\"hardwareBreakpoints\"," 
                   "\"writeMemory\",\"readMemoryBatch\",\"reset\",\"rtt\"," 
                   "\"stepIntoInstruction\",\"stepIntoSourceLine\",\"stepOverSourceLine\",\"stepOut\"]}}";
        }
      } else if (*method == "load") result = channel.loadJLink(*params);
      else if (*method == "connect") result = channel.connect(*params);
      else if (*method == "halt") result = channel.halt();
      else if (*method == "run") result = channel.run();
      else if (*method == "getState") result = channel.getState();
      else if (*method == "reset") result = channel.reset();
      else if (*method == "step") result = channel.step();
      else if (*method == "stepIntoInstruction") result = channel.stepIntoInstruction();
      else if (*method == "stepIntoSourceLine") result = channel.stepIntoSourceLine(*params);
      else if (*method == "stepOverSourceLine") result = channel.stepOverSourceLine(*params);
      else if (*method == "stepOut") result = channel.stepOut(*params);
      else if (*method == "readRegister") result = channel.readRegister(*params);
      else if (*method == "readMemory") result = channel.readMemory(*params);
      else if (*method == "readMemoryBatch") result = channel.readMemoryBatch(*params);
      else if (*method == "writeMemory") result = channel.writeMemory(*params);
      else if (*method == "setBreakpoint") result = channel.setBreakpoint(*params);
      else if (*method == "clearBreakpoint") result = channel.clearBreakpoint(*params);
      else if (*method == "clearAllBreakpoints") result = channel.clearAllBreakpoints();
      else if (*method == "startRtt") result = channel.startRtt(*params);
      else if (*method == "stopRtt") result = channel.stopRtt();
      else if (*method == "readRtt") result = channel.readRtt(*params);
      else if (*method == "disconnect") result = channel.disconnect();
      else if (*method == "shutdown") {
        channel.disconnect();
        result = "{\"ok\":true,\"message\":\"shutdown\",\"targetState\":\"" + channel.state() + "\",\"elapsedMs\":0,\"data\":{}}";
        std::cout << responseEnvelope(request, result) << '\n' << std::flush;
        break;
      } else {
        std::cout << protocolError(&request, "unknown method: " + *method, channel.state()) << '\n' << std::flush;
        continue;
      }
      std::cout << responseEnvelope(request, result) << '\n' << std::flush;
    } catch (const std::exception& error) {
      std::cout << protocolError(nullptr, error.what(), channel.state()) << '\n' << std::flush;
    }
  }
  return 0;
}
