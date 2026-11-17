#ifndef ORBIT_FIXTURE_SYSVIEW_CONF_H
#define ORBIT_FIXTURE_SYSVIEW_CONF_H
#include <stdint.h>
uint32_t FixtureTimestamp(void);
uint32_t FixtureInterruptId(void);
#define SEGGER_SYSVIEW_GET_TIMESTAMP() FixtureTimestamp()
#define SEGGER_SYSVIEW_GET_INTERRUPT_ID() FixtureInterruptId()
#if FIXTURE_MODE == 3
/* 3.32 固定通道的 Post-Mortem 分支未设置 context.UpChannel。
 * 使用官方自动分配路径，先保留通道 1 后实际分配到 2，不改记录器源码。 */
#define SEGGER_SYSVIEW_RTT_CHANNEL 0
#else
#define SEGGER_SYSVIEW_RTT_CHANNEL 2
#endif
#define SEGGER_SYSVIEW_RTT_BUFFER_SIZE 8192
#define SEGGER_SYSVIEW_TIMESTAMP_BITS 32
#define SEGGER_SYSVIEW_ID_BASE 0x20000000UL
#define SEGGER_SYSVIEW_ID_SHIFT 2
#define SEGGER_SYSVIEW_SYNC_PERIOD_SHIFT 5
#if FIXTURE_MODE == 3
#define SEGGER_SYSVIEW_POST_MORTEM_MODE 1
#else
#define SEGGER_SYSVIEW_POST_MORTEM_MODE 0
#endif
#endif
