#ifndef ORBIT_FIXTURE_RTT_CONF_H
#define ORBIT_FIXTURE_RTT_CONF_H
#define SEGGER_RTT_MAX_NUM_UP_BUFFERS 3
#define SEGGER_RTT_MAX_NUM_DOWN_BUFFERS 3
#define BUFFER_SIZE_UP 256
#define BUFFER_SIZE_DOWN 32
#define SEGGER_RTT_MODE_DEFAULT 0
#define RTT_USE_ASM 0
#if defined(FIXTURE_HOST)
/* 主机 oracle 单线程执行，只访问本进程的 RTT 内存。 */
#define SEGGER_RTT_LOCK()
#define SEGGER_RTT_UNLOCK()
#else
#include "stm32h7xx.h"
/* 每次锁保存 PRIMASK，允许标准记录组件内部嵌套调用。 */
#define SEGGER_RTT_LOCK() { uint32_t fixtureMask = __get_PRIMASK(); __disable_irq();
#define SEGGER_RTT_UNLOCK() __set_PRIMASK(fixtureMask); }
#endif
#endif
