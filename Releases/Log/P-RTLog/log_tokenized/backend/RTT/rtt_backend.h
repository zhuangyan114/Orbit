#ifndef RTT_BACKEND_H
#define RTT_BACKEND_H

#include <stddef.h>
#include <stdint.h>
#include "p_rtlog_config.h"
#include "SEGGER_RTT.h"
/// RTT channel used for tokenized log output.
/// Channel 0 is the default "Terminal" channel shared with J-Link RTT Viewer.
/// Use channel 1+ if you want to separate logs from terminal I/O.
#ifndef P_RTT_LOG_CHANNEL
#define P_RTT_LOG_CHANNEL 0
#endif

/// Initialize the RTT backend (optional, call once at startup).
void rtt_backend_init(void);

#endif  // RTT_BACKEND_H