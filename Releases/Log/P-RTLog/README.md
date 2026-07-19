# P-RTLog 嵌入式模块

P-RTLog 是一个基于 SEGGER RTT 的轻量级 tokenized log 模块。日志格式字符串在编译期转换为 token，运行时通过 RTT 发送 token 和编码后的参数，减少嵌入式端的传输数据量。

本目录提供可直接加入 STM32 工程的嵌入式端源码。项目原仓库：[moment-NEW/P-RTLog.git](https://github.com/moment-NEW/P-RTLog.git)。宿主端工具、完整示例和最新版本说明请以原仓库为准。

RTT 输出帧格式为：

```text
[2 字节 little-endian 长度][token + 编码参数]
```

## 集成到工程

将本目录复制到工程中，并将以下 C 文件加入目标：

```text
bsp_prtlog.c
log_tokenized/plog_tokenized_light.c
log_tokenized/backend/RTT/rtt_backend.c
log_tokenized/backend/RTT/SEGGER_RTT.c
```

添加 include 路径：

```text
P-RTLog/
P-RTLog/log_tokenized/
P-RTLog/log_tokenized/backend/RTT/
P-RTLog/stubs/
```

添加编译宏：

```text
USING_RTT_BACKEND
P_TOKENIZER_CFG_ARG_TYPES_SIZE_BYTES=4
P_TOKENIZER_CFG_C_HASH_LENGTH=128
```

GCC 链接时额外加入：

```text
-T P-RTLog/p_rtlog_tokenizer_sections.ld
```

该 linker script 会保留 `.pw_tokenizer.entries`，使宿主端能够从 ELF 文件中读取 token 对应的格式字符串。使用 Keil/ARM Compiler 6 时，按工程 scatter file 的规则引入 `p_rtlog_tokenizer_sections.sct`。

## 使用示例

应用代码只需要包含 `bsp_prtlog.h`：

```c
#include <stdint.h>
#include "bsp_prtlog.h"

static void App_LogExample(uint32_t count, float value, int temperature, int motor_id)
{
    P_RTLog_Information("count=%u value=%.2f", (unsigned)count, (double)value);
    P_RTLog_Warning("temperature=%d", temperature);
    P_RTLog_Error("motor %d stalled", motor_id);
}

int main(void)
{
    // HAL_Init、时钟和必要外设初始化之后调用一次。
    P_RTLog_Init();

    App_LogExample(10u, 25.5f, 85, 1);

    while (1) {
    }
}
```

`bsp_prtlog.h` 提供以下公共接口：

| 接口 | 说明 |
| --- | --- |
| `P_RTLog_Init()` | 初始化 RTT 后端，只调用一次 |
| `P_RTLog()` | 普通信息日志 |
| `P_RTLog_Information()` | 信息日志 |
| `P_RTLog_Warning()` | 警告日志 |
| `P_RTLog_Error()` | 错误日志 |

底层原生宏 `P_LOG`、`P_WARN`、`P_ERROR` 也可以直接使用。浮点参数通过可变参数传递时使用 `double`，例如 `(double)value`。

## 注意事项

- 只编译上面列出的纯 C 实现，不要同时编译 P-RTLog 的 C++ 实现，否则可能产生重复符号。
- 必须保留 linker script 中的 `.pw_tokenizer.entries`，否则宿主端无法还原日志格式字符串。
- RTT 默认使用 channel 0；如需调整，修改 `log_tokenized/p_rtlog_config.h` 中的配置。
- `SEGGER_RTT_ASM_ARMv7M.S` 为可选的 RTT 汇编实现。使用时应根据工程配置选择对应实现，避免重复链接相同符号。
- 日志通过 RTT 发送的是二进制帧，不是普通文本；查看日志时需要使用 P-RTLog 配套的宿主端解码工具。
