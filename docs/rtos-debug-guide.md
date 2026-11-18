# Orbit RTOS 调试指南

Orbit 内置底部 **RTOS** 面板（`Tasks & Objects`），直接通过当前活动调试会话的芯片接入通道获取 FreeRTOS 内核状态，不需要安装或注入第三方 `mcu-debug.rtos-views` 扩展。

## 前置条件

1. 编译固件时保留完整的 DWARF 调试信息（例如 GCC 使用 `-g` 或 `-g3`），不要对加载到调试器的 ELF 执行 `strip`。
2. 当前预览版本针对单核 ARM Cortex-M **FreeRTOS**（已在 STM32CubeH7 FreeRTOS 10.3.1 / ARM_CM4F 与 `heap_4` 矩阵校验），从 ELF DWARF 类型信息解析内核偏移，不依赖固定结构体偏移假设。
3. 目标芯片名称需能在 Orbit 设备数据库中解析对应 RAM 区域（在 `launch.json` 中配置 `device` 或在工作区配置 `orbit.defaultDevice`）。

## 启动与查看

1. 正常配置并启动 Orbit 调试会话（支持 J-Link 与 CMSIS-DAP/DAPLink）。如需显式指定默认 RTOS 名称，可在 `launch.json` 设置 `"rtos": "FreeRTOS"` 或在 VS Code 设置中配置 `orbit.defaultRtos`。
2. 打开底部面板区的 **RTOS** 视图（视图 ID：`ozoneRtos`）。
3. 可按页签查看：
   - **任务**：按状态/关键字筛选并排序任务、查看每行列表发现证据（`遍历` / `TCB校验`）、按需扫描指定或全部任务栈高水位，以及基于内核运行时间计数的 CPU% 估算与采集窗口说明。
   - **队列与锁**：查看可通过 `xQueueRegistry`、全局队列/信号量句柄或阻塞任务等待链表发现的 Queue、Mutex、Recursive Mutex 与 Semaphore，支持查看互斥锁持有者、递归层级、候选等待环及未解析等待列表。
   - **定时器与堆**：查看活动/全局可见的 Software Timers，以及经校验的 `heap_4` 容量、当前空余、历史最低空余与分配/释放统计。

## 常见状态说明

- **缺少 DWARF 调试信息 (`DwarfUnavailable`)**：加载的 ELF 缺少 `.debug_info` 或核心符号类型。请检查编译选项与 `program` 路径。
- **未检测到 FreeRTOS 内核 (`RtosNotDetected`)**：ELF 中缺少 `pxCurrentTCB`、`uxCurrentNumberOfTasks` 或 `pxReadyTasksLists`。
- **部分结果 (`partial`)**：目标运行中读取期间链表发生变动，或单帧详情预算达到上限；界面会明确标示降级原因并保留已独立校验的数据。

## 外部视图扩展兼容性

- Memory View（`memory-view`）、Peripheral Viewer 及 `mcu-debug.debug-tracker-vscode` 等外部扩展仍可通过 Orbit 提供的标准 DAP 能力（`supportsReadMemoryRequest`、`readMemory`、`writeMemory`、`variables`、`evaluate` 与 `memoryReference`）独立工作。
- Orbit 不再注册、依赖或向工作区写入 `mcu-debug.rtos-views.trackDebuggers` 与 `orbit.rtosViewsAutoRefresh`。
