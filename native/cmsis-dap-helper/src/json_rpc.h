#pragma once

#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace cmsis_dap_helper {

// Minimal JSON value/parser used by the JSON-lines RPC channel. Kept small
// and dependency-free on purpose; the wire format matches the J-Link helper
// conventions ({"id":n,"method":...,"params":{...}} -> {"id":n,"result":{...}}).
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

  static JsonValue fromString(const std::string& value) {
    JsonValue v;
    v.kind = Kind::String;
    v.string = value;
    return v;
  }

  static JsonValue fromNumber(double value) {
    JsonValue v;
    v.kind = Kind::Number;
    v.number = value;
    return v;
  }

  static JsonValue fromBoolean(bool value) {
    JsonValue v;
    v.kind = Kind::Boolean;
    v.boolean = value;
    return v;
  }

  static JsonValue objectOf(std::map<std::string, JsonValue> fields) {
    JsonValue v;
    v.kind = Kind::Object;
    v.object = std::move(fields);
    return v;
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

// Escapes a string for JSON output (double quotes, backslash, control chars).
std::string jsonEscape(const std::string& value);

// Renders a JsonValue back to compact JSON text.
std::string jsonSerialize(const JsonValue& value);

}  // namespace cmsis_dap_helper
