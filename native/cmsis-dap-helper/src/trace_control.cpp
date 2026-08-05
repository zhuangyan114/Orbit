#include "trace_control.h"

#include <cstdlib>

namespace cmsis_dap_helper {

bool rawTraceEnabledForValue(const char* value) {
  return value != nullptr && value[0] == '1';
}

bool rawTraceEnabled() {
#ifdef _MSC_VER
  char* value = nullptr;
  size_t length = 0;
  const errno_t error = _dupenv_s(&value, &length, "ORBIT_CMSIS_DAP_TRACE");
  const bool enabled = error == 0 && rawTraceEnabledForValue(value);
  if (value) std::free(value);
  return enabled;
#else
  return rawTraceEnabledForValue(std::getenv("ORBIT_CMSIS_DAP_TRACE"));
#endif
}

}  // namespace cmsis_dap_helper
