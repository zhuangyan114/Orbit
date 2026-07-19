#include "bsp_log.h"

  /**
   * @brief 日志系统初始化
   */
  void Log_Init(void)
  {
      SEGGER_RTT_Init();
      Log_Information("Log System Init Success");
  }

  