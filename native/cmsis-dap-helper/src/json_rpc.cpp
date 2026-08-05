#include "json_rpc.h"

#include <cstdlib>
#include <iomanip>
#include <sstream>

namespace cmsis_dap_helper {

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

std::string jsonSerialize(const JsonValue& value) {
  std::ostringstream output;
  switch (value.kind) {
    case JsonValue::Kind::Null:
      output << "null";
      break;
    case JsonValue::Kind::Boolean:
      output << (value.boolean ? "true" : "false");
      break;
    case JsonValue::Kind::Number: {
      const double number = value.number;
      if (number == static_cast<long long>(number) && number >= -9007199254740992.0 && number <= 9007199254740992.0) {
        output << static_cast<long long>(number);
      } else {
        output << std::setprecision(15) << number;
      }
      break;
    }
    case JsonValue::Kind::String:
      output << '"' << jsonEscape(value.string) << '"';
      break;
    case JsonValue::Kind::Array: {
      output << '[';
      bool first = true;
      for (const JsonValue& item : value.array) {
        if (!first) output << ',';
        first = false;
        output << jsonSerialize(item);
      }
      output << ']';
      break;
    }
    case JsonValue::Kind::Object: {
      output << '{';
      bool first = true;
      for (const auto& entry : value.object) {
        if (!first) output << ',';
        first = false;
        output << '"' << jsonEscape(entry.first) << "\":" << jsonSerialize(entry.second);
      }
      output << '}';
      break;
    }
  }
  return output.str();
}

}  // namespace cmsis_dap_helper
