#pragma once

namespace cmsis_dap_helper {

// Raw DAP/HID frame logging is intentionally opt-in because each line is
// synchronously forwarded to the extension log file.
bool rawTraceEnabledForValue(const char* value);
bool rawTraceEnabled();

}  // namespace cmsis_dap_helper
