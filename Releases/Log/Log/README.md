#bsp_log

## 概述
`bsp_log` 是一个用于处理日志输出的库，提供了对日志信息的封装和操作接口。该库旨在简化日志的配置和使用，使得开发者可以更方便地实现日志记录和调试功能。

## 环境
- 硬件平台：STM32

## 调试工具
目前仅支持J-link的SWO功能进行日志输出

## 使用指南
1. 从J-link官网下载J-link驱动并安装
2. 从自己jlink驱动目录`..\JLink\Samples\RTT`下找到 zip压缩包解压
3. 从解压文件中找到 `SEGGER_RTT.c`, `SEGGER_RTT.h`, `SEGGER_RTT_Conf.h`, `SEGGER_RTT_printf.c`文件，复制到项目中
4. 在代码里调用`Log_Init`函数初始化日志模块，以后便可用`Log_Info`, `Log_Warn`, `Log_Error`等函数打印日志
5. 在ozone或J-link RTT Viewer中查看日志输出即可

## 注意事项
- 目前仅仅支持J-link的SWO功能进行日志输出
- 需要在Ozone中配置RTT功能，具体配置方法请参考J-link的官方文档

## 使用示例
```C
#include "bsp_log.h"

int main(void)
{
    Log_Init(); // 初始化日志模块
    Log_Info("This is an info message.");//具体日志输出接口见 bsp_log.h
    Log_Warn("This is a warning message.");
    Log_Error("This is an error message.");
    while (1);
}

```