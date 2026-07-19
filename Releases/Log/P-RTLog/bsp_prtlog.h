#ifndef BSP_PRTLOG_H
#define BSP_PRTLOG_H

#include "log_tokenized/log_tokenized_light.h"
#include "log_tokenized/backend/RTT/rtt_backend.h"

/** 初始化 P-RTLog 的 RTT 后端；系统启动时调用一次即可。 */
void P_RTLog_Init(void);

/*
 * 对齐 bsp_log.h 的应用层接口。
 * P_LOG/P_WARN/P_ERROR 仍然保留，下面这些名字只是公共封装别名。
 */
#define P_RTLog(format, ...) \
    P_LOG(format, ##__VA_ARGS__)

#define P_RTLog_Information(format, ...) \
    P_LOG(format, ##__VA_ARGS__)

#define P_RTLog_Warning(format, ...) \
    P_WARN(format, ##__VA_ARGS__)

#define P_RTLog_Error(format, ...) \
    P_ERROR(format, ##__VA_ARGS__)

#endif
