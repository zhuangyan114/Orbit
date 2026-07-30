# 阶段 A：首批目标平台矩阵

状态：A02 已调整为当前可用的实测目标。项目配置、ELF 信息和 Native owner 已确认；物理 J-Link 型号、序列号、实际连接 DLL 和完整板卡信息仍待硬件记录。

## 1. 首批基线目标

| 项目 | 选择/记录 | 证据 | 状态 |
|---|---|---|---|
| 示例工程 | `D:\STM32\project\vet6_led` | 工程目录、`vet6_led.ioc` 和 `.vscode` 配置 | 已选 |
| MCU 原始型号 | `STM32F407VETx` / `STM32F407VET6` | `vet6_led.ioc` 的 `Mcu.Name`、`Mcu.CPN`、`ProjectManager.DeviceId` | 已确认 |
| Orbit 设备别名 | `STM32F407VE` | 工程 `.vscode/launch.json` | 已确认 |
| CPU/编译器 | Cortex-M4F；GNU Arm Embedded GCC，当前 Debug CMake 记录为 `13.3.1` | `ARM_CM4F` portable 路径、`build/Debug/CMakeFiles/.../CMakeCCompiler.cmake` | 已确认到构建记录 |
| RTOS | FreeRTOS Kernel `V10.3.1`，CMSIS-RTOS V1 配置 | `Core/Inc/FreeRTOSConfig.h`、`vet6_led.ioc` 的 `CMSIS_V1` | 已确认 |
| ELF | `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf` | 构建产物和工程 `.vscode/launch.json` | 已确认；测试 ELF 已校验 hash |
| 调试接口 | SWD | 工程 `.vscode/launch.json` | 已确认 |
| 接口速率 | 4000 kHz | 工程 `.vscode/launch.json`、`settings.json` | 已确认配置；未等同硬件通过 |
| J-Link DLL | 首选测试记录为本机 `C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`（9.56） | 本机文件版本检查 | 暂定，测试时必须重新记录 |
| 物理 J-Link 型号/序列号 | 待填写 | 当前仓库配置不包含探针身份 | 未完成 |

## 2. 当前配置风险

- 普通调试配置和专用 RTT 配置都必须明确记录 `rttLogEnabled`、`rttBufferIndex` 和轮询参数；当前专用配置使用独立 Up Channel 1，不能把 Channel 0 的日志状态当作吞吐结论。
- 当前配置的 `nativeDebugEngineMode` 为 `auto`。A03 必须分别记录最终 owner 是 Native 还是 Legacy；不能只记录 launch 中的请求模式。
- `vet6_led.elf` 必须与目标板实际烧录固件对应。构建成功或 ELF 存在不等于板上运行的是该 ELF。

## 3. 首批支持边界

首版只把以下组合作为正式基线：

```text
STM32F407VETx / Orbit alias STM32F407VE
+ FreeRTOS Kernel V10.3.1 + CMSIS-RTOS V1
+ Cortex-M4F / SWD / 4000 kHz
+ J-Link DLL 9.56（实际测试时记录路径、版本和物理探针）
```

其他 J-Link DLL、其他 STM32 型号、其他 FreeRTOS 版本可以作为兼容性扩展，但不能混入首批性能数字。
