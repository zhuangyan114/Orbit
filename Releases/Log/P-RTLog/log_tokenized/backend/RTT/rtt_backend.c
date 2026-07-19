/**
 * @file rtt_backend.c
 * @brief RTT backend for tokenized logging
 *
 * Implements pw_log_tokenized_HandleLogWithoutMetadata() by writing
 * length-prefixed binary frames to SEGGER RTT.
 *
 * Frame format: [2-byte LE length][encoded message bytes]
 * The host-side decoder reads the length first, then reads that many bytes.
 */

#include "log_tokenized/backend/RTT/rtt_backend.h"

#include <string.h>
#include "SEGGER_RTT.h"

void rtt_backend_init(void) {
    SEGGER_RTT_Init();
}
#ifdef USING_RTT_BACKEND
/// Called by the tokenized logging pipeline for every log message.
/// Writes a length-prefixed frame so the host can parse individual messages.
void pw_log_tokenized_HandleLogWithoutMetadata(
    const uint8_t encoded_message[], size_t size_bytes) {
    if (encoded_message == NULL || size_bytes == 0) {
        return;
    }

    // Clamp to uint16_t max (65535 bytes per frame)
    if (size_bytes > 0xFFFF) {
        size_bytes = 0xFFFF;
    }

    // 2-byte little-endian length prefix
    //RTT协议要求每条日志前加若干字节长度信息
    uint8_t header[2];
    header[0] = (uint8_t)(size_bytes & 0xFF);
    header[1] = (uint8_t)((size_bytes >> 8) & 0xFF);

    // Write header + payload to RTT channel
    SEGGER_RTT_Write(P_RTT_LOG_CHANNEL, header, sizeof(header));
    SEGGER_RTT_Write(P_RTT_LOG_CHANNEL, encoded_message, (unsigned)size_bytes);
}
#endif  // USING_RTT_BACKEND