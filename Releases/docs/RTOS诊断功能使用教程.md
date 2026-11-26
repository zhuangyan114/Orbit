# Orbit RTOS 诊断功能详细介绍与使用教程

> 适用版本：Orbit for VS Code `1.2.2` 及以上  
> 适用范围：ARM Cortex-M（单核）FreeRTOS 内核快照诊断与 SEGGER SystemView Trace 全链路分析

Orbit 内置了原生 **RTOS 诊断面板**（位于 VS Code 底部面板区，视图名 **RTOS**，视图 ID：`ozoneRtos`），直接复用当前活动调试会话的芯片接入通道，无需安装第三方 `mcu-debug.rtos-views` 扩展，也无需启动外部 Ozone 或 SystemView 桌面软件，即可在 VS Code 内完成**内核对象快照**、**实时/离线任务与中断泳道分析**、**上下文 CPU 负载与延迟统计**、**百万级事件检索**以及**与变量 TIMELINE 波形的跨面板时间联动**。

---

## 目录

- [1. 功能架构与核心优势](#1-功能架构与核心优势)
- [2. 前置条件、固件配置与 `launch.json` 详解](#2-前置条件固件配置与-launchjson-详解)
  - [2.1 编译选项与工具链要求](#21-编译选项与工具链要求)
  - [2.2 `FreeRTOSConfig.h` 关键宏与解锁能力对照](#22-freertosconfigh-关键宏与解锁能力对照)
  - [2.3 `launch.json` 与 VS Code 设置详解](#23-launchjson-与-vs-code-设置详解)
  - [2.4 当前支持范围与实板验证基线](#24-当前支持范围与实板验证基线)
- [3. Tasks & Objects：FreeRTOS 内核快照诊断](#3-tasks--objectsfreertos-内核快照诊断)
  - [3.1 顶部工具栏、能力状态条与一致性徽章](#31-顶部工具栏能力状态条与一致性徽章)
  - [3.2 任务（Tasks）列表与详情侧栏](#32-任务tasks列表与详情侧栏)
  - [3.3 队列与锁（Objects）与死锁等待环检测](#33-队列与锁objects与死锁等待环检测)
  - [3.4 定时器与堆（Timers & Heap）](#34-定时器与堆timers--heap)
  - [3.5 诊断折叠区（Diagnostics）](#35-诊断折叠区diagnostics)
- [4. 固件接入 SEGGER SystemView 完整步骤](#4-固件接入-segger-systemview-完整步骤)
  - [4.1 准备源码与头文件](#41-准备源码与头文件)
  - [4.2 `SEGGER_RTT_Conf.h` 与 `SEGGER_SYSVIEW_Conf.h` 配置要点](#42-segger_rtt_confh-与-segger_sysview_confh-配置要点)
  - [4.3 时钟初始化与启动约定](#43-时钟初始化与启动约定)
- [5. Trace Timeline：任务与中断泳道分析](#5-trace-timeline任务与中断泳道分析)
  - [5.1 通道探测与三种录制模式](#51-通道探测与三种录制模式)
  - [5.2 录制控制：开始、停止、暂停接收与取消](#52-录制控制开始停止暂停接收与取消)
  - [5.3 泳道交互、缩放导航与 A/B 游标操作](#53-泳道交互缩放导航与-ab-游标操作)
  - [5.4 时间单位、多段（Segment）与缺口诊断](#54-时间单位多段segment与缺口诊断)
- [6. Contexts & Events：统计、Marker、事件流与 Trace 终端](#6-contexts--events统计marker事件流与-trace-终端)
  - [6.1 统计范围、精度模式与 CPU Load 分箱图](#61-统计范围精度模式与-cpu-load-分箱图)
  - [6.2 上下文统计（Contexts）](#62-上下文统计contexts)
  - [6.3 Markers（自定义打点分析）](#63-markers自定义打点分析)
  - [6.4 事件列表（Events）与参数解码器](#64-事件列表events与参数解码器)
  - [6.5 Trace 终端与异常/坏包诊断抽屉](#65-trace-终端与异常坏包诊断抽屉)
- [7. 跨面板时间联动：RTOS Trace ↔ 变量 TIMELINE](#7-跨面板时间联动rtos-trace--变量-timeline)
  - [7.1 实时同会话联动](#71-实时同会话联动)
  - [7.2 离线记录手动对齐（单点 A / 双点 A+B 校准）](#72-离线记录手动对齐单点-a--双点-ab-校准)
- [8. 录制归档、离线回放与数据导出](#8-录制归档离线回放与数据导出)
  - [8.1 `orbit-trace-v1` 归档保存、打开与损坏恢复](#81-orbit-trace-v1-归档保存打开与损坏恢复)
  - [8.2 导出 `.bin` 原始流与 39 列 `.csv` 表格](#82-导出-bin-原始流与-39-列-csv-表格)
  - [8.3 关于 SEGGER `.SVDat` 格式的说明](#83-关于-segger-svdat-格式的说明)
- [9. 典型工程故障排查实战流程](#9-典型工程故障排查实战流程)
- [10. Automation API 与 MCP 自动化接入](#10-automation-api-与-mcp-自动化接入)
- [11. 常见错误码与问题排查速查表](#11-常见错误码与问题排查速查表)

---

## 1. 功能架构与核心优势

Orbit RTOS 诊断系统在底部 **RTOS** 面板中分为三个顶层子视图，覆盖从**静态/轮询内核态**到**微秒级动态调度轨迹**的完整诊断链路：

| 顶层页签 | 子模块 | 核心能力 | 依赖固件条件 |
| --- | --- | --- | --- |
| **Tasks & Objects** | 任务 / 队列与锁 / 定时器与堆 | 读取 FreeRTOS 任务状态、优先级、栈高水位、CPU%、Queue/Mutex/Semaphore 持有与等待环、Software Timers 及 `heap_4` 内存统计 | 仅需带 DWARF 调试信息的 FreeRTOS ELF（**无需改动业务代码**） |
| **Trace Timeline** | 录制控制 / 任务与中断泳道 / A-B 游标 | 录制并回放微秒级任务切换、就绪、ISR 抢占、系统调用与 Marker 泳道，支持与变量 TIMELINE 时间轴联动 | 需固件集成 SEGGER SystemView 并提供 `SysView` RTT 通道 |
| **Contexts & Events** | 上下文统计 / Markers / 事件列表 / Trace 终端 | CPU Load 分箱图、各任务/ISR 独占与包含耗时及 Ready 延迟统计、百万级分页事件与 FreeRTOS API 参数解码、Trace 文本终端 | 同上（支持无硬件离线打开归档分析） |

### 相比传统调试方案的核心特点

1. **单会话独占物理探针**：所有快照读取与 SystemView RTT 访问均复用当前活动的 Orbit 调试会话（支持 J-Link、CMSIS-DAP/DAPLink 与 RMLink），不会创建第二个探针连接，避免总线冲突或探针掉线。
2. **不猜偏移量的 DWARF 自适应解析**：从 ELF 中内核全局符号所指向的真实 DWARF 类型图推导结构体成员偏移（兼容不同编译优化等级 `-Og`/`-O2`、不同 `configMAX_PRIORITIES`、是否开启统计或栈高地址等裁剪配置），绝不用写死的偏移量碰运气。
3. **不以猜测冒充事实**：字段无法校验时明确显示「不可用」并附带原因；运行中读取若遇链表变化，明确标示 `partial` 并标注每行发现证据；Trace 若遇溢出或丢包，明确标注**缺口（Gap）**并阻断跨缺口错误统计。
4. **调度隔离与高吞吐独立 Worker**：
   - 探针总线调度严格遵守 `控制（单步/断点/暂停/写变量） > Watch > TIMELINE > 后台（RTOS快照/RTT）` 优先级，RTOS 刷新和 Trace 读取不会卡死调试控制。
   - Trace 解码、建索引、聚合统计与 CSV 导出在独立后台 Worker 进程中运行，实测解码速率近 10 万包/秒，百万级事件视口与精确点查询 P95 在 15 ms 以内。

---

## 2. 前置条件、固件配置与 `launch.json` 详解

### 2.1 编译选项与工具链要求

1. **保留完整 DWARF 调试信息**：
   - GCC 编译参数需包含 `-g` 或 `-g3`（推荐 `-Og -g3 -gdwarf-4`，优化发布排查也可使用 `-O2 -g3 -gdwarf-4`）。
   - **禁止**对提供给 Orbit `program` 的 `.elf` / `.axf` 执行 `arm-none-eabi-strip`，否则会丢失 `.debug_info` 导致报 `DwarfUnavailable`。
2. **安装 GNU Arm 符号工具链**：
   - 确保 `arm-none-eabi-nm.exe`、`arm-none-eabi-objdump.exe` 与 `arm-none-eabi-addr2line.exe` 所在目录在系统 `PATH` 中。
3. **正确配置目标芯片型号**：
   - 在 `launch.json` 中填写准确的 `device`（或在 VS Code 设置中填写 `orbit.defaultDevice`），Orbit 依赖设备数据库中的合法 RAM 地址范围对内核链表指针和 TCB 地址做越界校验。

### 2.2 `FreeRTOSConfig.h` 关键宏与解锁能力对照

不同 FreeRTOS 裁剪配置会自动对应解锁不同诊断列；未开启的宏会导致对应列安全降级为「不可用」，不影响其余功能：

| FreeRTOS 配置项 | 推荐值 | 解锁的 Orbit RTOS 诊断能力 |
| --- | --- | --- |
| `configUSE_TRACE_FACILITY` | `1` | 解锁任务唯一创建编号（`uxTaskNumber` / `#N`）、精确跨帧身份追踪、队列类型识别以及 SystemView 插桩 |
| `configRECORD_STACK_HIGH_ADDRESS` | `1` | 解锁精确栈容量（`pxStack` 至 `pxEndOfStack`）与按需栈高水位扫描 |
| `configGENERATE_RUN_TIME_STATS` | `1` | 解锁任务累计运行计数与双帧差分 CPU% 估算（需同时实现 `portCONFIGURE_TIMER_FOR_RUN_TIME_STATS()` 与 `portGET_RUN_TIME_COUNTER_VALUE()`） |
| `configQUEUE_REGISTRY_SIZE` | `> 0`（如 `12`） | 解锁通过 `vQueueAddToRegistry()` 注册的命名队列、互斥锁与信号量发现 |
| `configUSE_MUTEXES` / `configUSE_RECURSIVE_MUTEXES` / `configUSE_COUNTING_SEMAPHORES` | `1` | 解锁互斥锁持有者、递归锁定深度、信号量计数与候选等待环检测 |
| `configUSE_TIMERS` | `1` | 解锁「定时器与堆」页签中的 Software Timers 列表与到期 Tick 监控 |
| `heap_4.c`（动态分配器） | 链接 `heap_4` | 解锁 `Heap 概览` 中的总容量、当前剩余、历史最低剩余及分配/释放次数 |

### 2.3 `launch.json` 与 VS Code 设置详解

在大多数工程中，正常配置 Orbit 调试即可自动发现 FreeRTOS。若需显式指定 RTOS 或为**栈水位扫描**与**CPU% 运行统计**提供精确端口口径，可按如下方式配置：

#### 1. 工作区/用户级默认设置（`settings.json`）

```jsonc
{
  "orbit.defaultDevice": "STM32H723VG",
  "orbit.defaultRtos": "FreeRTOS"
}
```

#### 2. `launch.json` 完整配置示例

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Orbit: FreeRTOS 诊断 (J-Link)",
      "type": "orbit",
      "request": "launch",
      "program": "${workspaceFolder}/build/app.elf",
      "device": "STM32H723VG",
      "interface": "SWD",
      "speedKHz": 4000,
      "rtos": "FreeRTOS",
      "flashBeforeDebug": true,
      "runToEntryPoint": "main",

      // 可选：显式声明已核对的 port 栈与运行统计参数
      "rtosSnapshotPort": {
        "source": "GCC/ARM_CM4F",
        "stackGrowth": "down",       // "down" (Cortex-M 向下增长) 或 "up"
        "stackFillByte": 165,        // FreeRTOS 默认栈填充字节 0xA5 = 165
        "runtime": {
          "source": "DWT_CYCCNT",    // 运行时间统计计数器来源标识
          "frequencyHz": 64000000,   // 计数器实际频率 (Hz)，例如 64 MHz 或 550 MHz
          "countsDuringSleep": false // 进入低功耗休眠(WFI/Tickless)时计数器是否继续累加
        }
      }
    }
  ]
}
```

> **使用 RMLink 或 CMSIS-DAP/DAPLink 时**：只需在上述配置中补充 `"probe": "rmlink"`（多设备时加 `"rmlinkDeviceId": "..."`）或 `"probe": "cmsis-dap"`（可选 `"cmsisDapTransport": "cmsis-dap-v2"` / `"tcp"`），RTOS 快照与 Trace 流程完全一致。
>
> **关于 `rtosSnapshotPort`**：如果未填写，Orbit 不会臆测端口的栈填充字节或计数器主频，相关列会提示缺失条件；按目标工程实际参数填写后即可解锁完整栈水位扫描与 CPU% 估算。

### 2.4 当前支持范围与实板验证基线

- **已实板验收基线**：
  - 芯片/内核：`STM32H723VGT6`（Cortex-M7 单核、小端、32 位指针）+ `FreeRTOS 10.3.1`（`GCC ARM_CM4F`、`heap_4`）+ `SystemView 3.32.0`。
  - 链路长稳：通过 **RMLink Wi-Fi 0.3.4**（4 MHz SWD），实测 **30 分钟 Continuous Trace（1,136,517 B、189,395 包，零溢出零丢包）** 与 **5 ms 变量 TIMELINE 采样（326,745 样本）**、**14 次运行态 RTOS 快照** 及 **5 次暂停/继续控制**共存通过。
- **其他组合说明**：
  - J-Link（native / legacy）与 CMSIS-DAP（WinUSB v2 / HID v1）已通过原生构建、mock 通道与会话隔离回归测试。
  - 若工程开启了 Cortex-M7 D-Cache，请留意 RTT 控制块与缓冲区所在的 RAM 区域需配置为 Non-Cacheable（如通过 MPU）或在读写处保证缓存一致性。

---

## 3. Tasks & Objects：FreeRTOS 内核快照诊断

启动调试后，在 VS Code 底部面板区点击 **RTOS**（如果被隐藏，可在底部面板标题栏右键勾选 **RTOS**，或按 `Ctrl + Shift + P` 搜索视图打开），默认进入 **Tasks & Objects** 页签。

### 3.1 顶部工具栏、能力状态条与一致性徽章

#### 顶部主工具栏控件

| 控件 | 功能与使用建议 |
| --- | --- |
| **会话状态点与一致性徽章** | 实时显示会话连接状态与当前快照可信等级（见下表）。 |
| **页签导航** | 在 `Tasks & Objects`、`Trace Timeline`、`Contexts & Events` 间切换。 |
| **刷新 / 取消** | 手动触发一次快照读取；读取过程中变为「取消」，点击可立即中止当前批量读取。 |
| **Live** | 开启按固定周期后台只读轮询任务列表。面板被折叠隐藏时自动暂停轮询，不浪费总线带宽。 |
| **Live含扩展** | 开启后，Live 轮询会同步刷新「队列与锁」「定时器与堆」。会增加每轮总线 I/O，Wi-Fi 或低速探针建议按需勾选，日常优先在暂停态手动点击刷新。 |
| **周期下拉框** | 选择 Live 轮询间隔：`200 ms (5 Hz)`、`500 ms (2 Hz)`、`1000 ms (1 Hz)`、`2000 ms (0.5 Hz)`。 |
| **扫描全部栈** | 按需对当前所有任务执行一次栈填充区扫描以获取历史高水位（轻量刷新默认不扫栈，以保证速度）。 |
| **诊断** | 展开/折叠底部快照诊断信息栏（查看读取轮次、字节数、预算消耗与问题清单）。 |

#### 一致性徽章（Consistency）含义

- **`halted-consistent`（绿色）**：目标处于暂停状态，整次读取期间内核内存静止、代次未变且链表结构完整，**最适合做精确核对与死锁确认**。
- **`live-best-effort`（蓝色）**：目标运行中完成采集，前后锚点校验一致，适合观察运行趋势，但无法从硬件上证明读取瞬间无并发调度。
- **`partial`（黄色）**：运行中读取期间检测到内核链表发生变动，或单帧详情预算达到上限。此时列表仍会展示通过独立校验的数据，不可信部分不会伪造。
- **`stale` / `unavailable`（灰色/警告）**：目标已断开或最新一次读取失败，界面可能保留上一次成功快照并标注原始采集时间。

#### 能力状态条与耗时监控条

工具栏下方固定两行状态条（防止实时刷新时界面抖动）：
- **第一行（能力芯片）**：依次列出 `✓/ −` 状态的 8 项能力：`任务快照`、`栈边界`、`栈水位`、`运行计数`、`CPU%`、`队列与锁`、`定时器`、`堆概览`。**鼠标悬停在任意灰色 `−` 标签上**，可直接看到该项不可用的精确原因（如缺少哪个宏或配置）。
- **第二行（性能与错误）**：显示快照序号 `#N`、完成时间、`总耗时 (I/O / 排队)` 及 `读取字节数 / 批次数`。

### 3.2 任务（Tasks）列表与详情侧栏

在 **Tasks & Objects** → **任务 (N)** 子页签下：

1. **搜索与状态筛选**：
   - 搜索框支持按**任务名、TCB 地址（如 `0x2000...`）或所属列表名**即时过滤。
   - 状态芯片支持按 `全部`、`Running`、`Ready`、`Blocked`、`Suspended`、`Termination` 过滤。
   - 点击表头（状态、任务名、TCB、优先级、栈水位/容量、CPU%/计数）可升降序排序。
2. **表格各列详解**：
   - **状态**：当前正在 CPU 上运行的任务会带有 `● Running` 标记。
   - **任务名**：显示任务名及创建编号 `#N`。若未开启 `configUSE_TRACE_FACILITY`，会标注「身份不确定」（防止把 TCB 复用后的新任务误算进旧任务的 CPU 差分）。
   - **TCB**：32 位十六进制 TCB 起始地址。
   - **优先级**：正常显示当前优先级；当发生**互斥锁优先级继承**时，会显示为 `当前优先级 (base 基础优先级)`（例如 `5 (base 2)`），一眼识别优先级提升现象。
   - **所属列表与证据**：显示任务所在内核链表（如 `Ready[2]`、`Delayed1`、`Suspended`），并附带发现证据徽章：
     - `遍历`：通过双向链表完整遍历并校验获得。
     - `TCB校验`：运行态链表变动期间，经重新读取 TCB 的 owner/container 指针独立校验获得。
   - **栈水位 / 容量**：显示 `已用峰值 / 总容量 B` 及可视化进度条（**使用率超过 85% 时进度条自动高亮告警**）。每行内置独立的 **「扫描」** 按钮，可只针对单个高风险任务扫描栈水位。
   - **CPU% / 计数**：显示双帧差分计算得到的 CPU 占比以及原始累计运行计数值（鼠标悬停可看统计来源与双帧采集窗口时长）。
3. **任务详情侧栏**：
   - **单击任意任务行**（或选中后按 `Enter`/`Space`），右侧展开详情侧栏，显示：TCB 地址、创建编号、完整列表证据、栈起止地址（`pxStack .. pxEndOfStack`）、栈容量与未用峰值、栈扫描参数（方向/填充字节/已扫字节/耗时）、运行计数与位宽、CPU% 双帧间隔与统计口径。
   - 若该任务当前**持有互斥锁**或**正在等待某个队列/锁**，侧栏底部会列出「对象等待 / 持有」清单，**点击对象名可直接跳转到「队列与锁」页签并高亮选中该对象**。

### 3.3 队列与锁（Objects）与死锁等待环检测

切换到 **队列与锁 (N)** 子页签（若首次打开尚未采集，点击 **「读取队列与锁」** 或工具栏 **「刷新全部详情」**）：

1. **三大发现来源与覆盖提示**：
   - 顶部覆盖条会显示三种来源各自发现的对象数：`Registry`（通过 `xQueueRegistry` 注册）、`Global`（通过 ELF 全局句柄/静态结构体符号发现）、`WaitList`（从阻塞任务的 `xEventListItem` 反推发现）。
2. **筛选与分类**：
   - 支持搜索对象名、符号名、地址或持有者；分类芯片支持 `全部`、`Queue`、`Mutex / 递归锁`、`Semaphore`、`异常 / 删除中`。
3. **表格各列说明**：
   - **类型**：Queue / Mutex / Recursive Mutex / Binary Semaphore / Counting Semaphore（类型存在不确定性时会带 `?` 标记）。
   - **计数 / 容量**：显示 `当前消息数 / 队列长度 (单项字节数)`，例如 `3 / 16 (32B)`。
   - **持有者 / 递归**：互斥锁显示当前持有者任务名（空闲显示「空闲」），递归互斥锁额外显示递归层数（如 `Coordinator ×2`），并附带可信度标签（`暂停态已校验` / `运行态尽力采集` / `部分/未双端校验`）。
   - **等待任务**：显示 `收:N 发:M`（等待读取/获取与等待写入/发送的任务数量）。若当前仅加载摘要，点击行内 **「详情」** 可展开读取完整等待任务列表。
   - **状态 / 说明**：基于 `heap_4` 块头与结构完整性交叉校验对象生命周期，区分 `正常`、`静态`、`未确认（块已分配）`、`已释放`、`删除中/异常`。
4. **⚠ 候选等待环（死锁预警）与未解析等待列表**：
   - 当系统检测到如 `TaskA → [Mutex1] → TaskB → [Mutex2] → TaskA` 的闭环等待关系时，子页签标签栏及表格顶部会显示醒目的 **⚠ 候选等待环** 横幅，并注明置信度（`暂停态已校验` 还是 `运行态尽力采集`）。
   - 选中对象后，在右侧详情面板中点击持有者或等待任务，可**一键跳回「任务」页签**查看其详细状态。

### 3.4 定时器与堆（Timers & Heap）

切换到 **定时器与堆 (N)** 子页签，点击 **「刷新定时器与堆」** 或顶部 **「刷新」**：

#### 1. Heap 概览卡片（支持 `heap_4`）
- 标题栏显示分配器类型与初始化状态徽章（如 `heap_4 · 已初始化`）。
- 展示 5 项核心指标：
  1. **已用 / 可用容量**（含使用率百分比及进度条，超过 85% 标红警戒）
  2. **配置总缓冲（`ucHeap`）**
  3. **当前剩余（`xFreeBytesRemaining`）**
  4. **历史最低剩余（`minimumEverFreeBytes`）**——排查内存峰值逼近上限的核心指标
  5. **成功分配 / 释放次数**（`xNumberOfSuccessfulAllocations / Frees`）——若分配数持续高于释放数且剩余内存单调下降，即提示存在堆内存泄漏风险

#### 2. Software Timers 表格
- 顶部显示当前内核 `Tick` 计数，以及 `当前活动列表`、`溢出列表`、`全局已停止` 定时器计数。
- 支持按 `全部`、`活动`、`已停止` 筛选以及关键字搜索（定时器名、符号、地址或回调）。
- 表格包含 9 列：`状态`、`定时器名 / 符号`、`地址`、`发现来源 (ActiveList / Global)`、`模式 / 分配 (AutoReload/OneShot · 静态/动态)`、`周期 (ticks)`、`下次到期 tick`、`回调地址 / TimerID`、`健康说明`。

### 3.5 诊断折叠区（Diagnostics）

点击顶部 **「诊断」** 按钮，底部会展开元数据诊断区，便于排查性能或环境问题：
- 显示当前快照的 `一致性`、`内核来源`、`会话/段/启动/操作代次`、`ELF / Layout SHA 摘要`、`读取统计（轮次/批次数/节点数/字节数）`、`详情预算分项消耗（栈/对象/定时器/堆）`、`已覆盖的内核链表` 以及完整 `问题清单`。

---

## 4. 固件接入 SEGGER SystemView 完整步骤

> **注意**：如果只需要使用 **Tasks & Objects** 快照功能，**可以跳过本节**；只有需要使用 **Trace Timeline** 与 **Contexts & Events** 时才需要在固件中接入 SystemView。

### 4.1 准备源码与头文件

1. 将官方 **SEGGER RTT**（`SEGGER_RTT.c`、`SEGGER_RTT.h` 等）与 **SEGGER SystemView**（`SEGGER_SYSVIEW.c`、`SEGGER_SYSVIEW.h` 及对应 FreeRTOS 版本的 `SEGGER_SYSVIEW_FreeRTOS.c`、`SEGGER_SYSVIEW_FreeRTOS.h`、`SEGGER_SYSVIEW_Config_FreeRTOS.c`）加入固件工程参与编译。
2. 在 `FreeRTOSConfig.h` 中开启 `configUSE_TRACE_FACILITY` 并在文件末尾引入 SystemView 适配器：

```c
#define configUSE_TRACE_FACILITY 1

/* 放在 FreeRTOSConfig.h 末尾 */
#include "SEGGER_SYSVIEW_FreeRTOS.h"
```

3. 确保链接器保留 `_SEGGER_RTT` 符号（不要将其优化移除）以及完整 DWARF 调试段。

### 4.2 `SEGGER_RTT_Conf.h` 与 `SEGGER_SYSVIEW_Conf.h` 配置要点

#### `SEGGER_RTT_Conf.h` 参考配置

- 预留至少 `3` 个 Up/Down 通道，保证普通文本日志（通道 0 `Terminal`）与 SystemView 二进制流（如通道 1 或 2 `SysView`）完全分离，二者可同时使用互不污染。
- 临界区锁建议保存并恢复 `PRIMASK`，避免嵌套中断破坏 RTT 指针：

```c
#define SEGGER_RTT_MAX_NUM_UP_BUFFERS   3
#define SEGGER_RTT_MAX_NUM_DOWN_BUFFERS 3
#define BUFFER_SIZE_UP                  256   // 通道 0 文本日志缓冲区
#define BUFFER_SIZE_DOWN                32
#define RTT_USE_ASM                     0

#include "stm32h7xx.h" // 按实际芯片头文件替换
#define SEGGER_RTT_LOCK()   { uint32_t _mask = __get_PRIMASK(); __disable_irq();
#define SEGGER_RTT_UNLOCK() __set_PRIMASK(_mask); }
```

#### `SEGGER_SYSVIEW_Conf.h` 参考配置

```c
#define SEGGER_SYSVIEW_GET_TIMESTAMP()    (DWT->CYCCNT)
#define SEGGER_SYSVIEW_GET_INTERRUPT_ID() ((*(uint32_t *)0xE000ED04UL) & 0x1FFUL) // ICSR.VECTACTIVE

#define SEGGER_SYSVIEW_RTT_CHANNEL        1      // 独立于通道 0；Post-Mortem 3.32 见下方注意
#define SEGGER_SYSVIEW_RTT_BUFFER_SIZE    8192   // 建议 4096~16384 字节，无线/高负载建议 >= 8192
#define SEGGER_SYSVIEW_TIMESTAMP_BITS     32
#define SEGGER_SYSVIEW_ID_BASE            0x20000000UL // 目标 RAM 基地址
#define SEGGER_SYSVIEW_ID_SHIFT           2
#define SEGGER_SYSVIEW_SYNC_PERIOD_SHIFT  5

// Continuous / Single-Shot 设为 0；Post-Mortem 回卷模式设为 1
#define SEGGER_SYSVIEW_POST_MORTEM_MODE   0
```

> **SystemView 3.32 Post-Mortem 特别提示**：在官方 3.32.0 版本中，若启用 `SEGGER_SYSVIEW_POST_MORTEM_MODE 1` 且固定指定非零 `SEGGER_SYSVIEW_RTT_CHANNEL`，记录器内部存在未赋值 `UpChannel` 导致事件与同步写错通道的已知行为。使用 Post-Mortem 时可将 `SEGGER_SYSVIEW_RTT_CHANNEL` 设为 `0` 让其自动分配独立 `SysView` 通道（Orbit 按通道名称 `SysView` 动态发现，不硬编码通道号）。

### 4.3 时钟初始化与启动约定

在 `main()` 启动调度器（`vTaskStartScheduler()`）之前：

1. **使能 Cortex-M DWT 周期计数器**：
   ```c
   CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
   DWT->CYCCNT = 0;
   DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
   ```
2. **初始化 SystemView**：调用 `SEGGER_SYSVIEW_Conf()`（内部调用 `SEGGER_SYSVIEW_Init(SystemCoreClock, SystemCoreClock, &SYSVIEW_X_OS_TraceAPI, _cbSendSystemDesc)`，务必传入与 `DWT->CYCCNT` 一致的真实主频，否则时间轴纳秒换算会失真）。
3. **启动时机约定**：
   - **Continuous（流式）模式**：**不要**在固件初始化时主动调用 `SEGGER_SYSVIEW_Start()`，让固件处于「已初始化、等待宿主经 RTT Down 发送 `START`」的状态。
   - **Single-Shot / Post-Mortem 模式**：按对应模式约定在固件端启动并触发冻结（`SEGGER_SYSVIEW_Stop()`），随后由 Orbit 读取冻结缓冲区。

---

## 5. Trace Timeline：任务与中断泳道分析

切换到 **RTOS** 面板 → **Trace Timeline** 页签。

### 5.1 通道探测与三种录制模式

1. 启动 Orbit 调试并从 `main` 入口断点**继续运行**（确保固件已执行完 `SEGGER_SYSVIEW_Conf()`）。
2. 点击工具栏的 **「探测通道」**（只读操作，不会修改目标内存或暂停 CPU）。
3. 核对第三行状态条反馈：
   - 正常示例：`目标 Running · Up=ch1(8192B) · Down=ch1`（若为 Post-Mortem 固件会额外显示 `· Post-Mortem固件`）。
4. 在模式下拉框中选择对应模式：

| 录制模式 | 工作原理 | 适用场景 | 目标端要求 |
| --- | --- | --- | --- |
| **Continuous (流式)** | Orbit 经 RTT Down 通道发送 `START`，后台持续消费 RTT Up 环形缓冲区并实时解码落盘，停止时发送 `STOP` 并排空剩余数据 | 日常长时间监控、与变量 TIMELINE 共存联调、性能剖析 | 需要 `SysView` Up + Down 通道；固件等待宿主 `START` |
| **Single-Shot (单次)** | 采集目标端单次触发填满或显式停止后的冻结缓冲区内容 | 高事件率短时捕获（避免无线/总线带宽成为瓶颈） | 固件按 Single-Shot 方式记录并在完成后冻结 |
| **Post-Mortem (回卷)** | 直接读取目标 RAM 中持续回卷覆盖的环形缓冲区（不推进读指针），保留故障/触发前的最后一段轨迹 | 偶发死机、HardFault、看门狗复位前现场回溯 | 固件开启 `SEGGER_SYSVIEW_POST_MORTEM_MODE 1` |

### 5.2 录制控制：开始、停止、暂停接收与取消

- **开始录制**：显式启动当前所选模式的录制（不会自动触发目标 Halt 或 Reset）。
- **停止录制**：向目标发送停止指令，等待有界排空并提交所有数据落盘，完成后状态变为 `stopped` 并可立即保存或导出。
- **暂停接收 / 恢复接收**（仅 Continuous 模式可用）：**仅暂停主机端拉取和更新视口**，目标端仍继续向环形缓冲写入（注意长时间暂停接收可能导致目标缓冲满溢出，恢复后会如实记录缺口）。
- **取消**：当处于 `preparing` 或 `stopping` 过渡阶段时可强制中止等待。

> **录制记录切换**：如果本次会话录制了多段，或同时打开了多个离线归档，可在记录下拉框中随时切换查看任意一条记录，互不覆盖。

### 5.3 泳道交互、缩放导航与 A/B 游标操作

Trace Timeline 采用分层泳道渲染（包含中断 ISR 泳道、各 FreeRTOS 任务泳道、调度器/Idle 状态及 Marker 标注），交互方式如下：

| 操作 | 触发方式 | 效果 |
| --- | --- | --- |
| **水平缩放** | 鼠标滚轮，或点击工具栏 `放大 +` / `缩小 −` | 以指针位置或视口中心缩放时间轴 |
| **水平平移** | 在泳道空白处按住鼠标左键拖动，或点击 `◀` / `▶` | 左右滑动浏览历史轨迹 |
| **全览 / 最新** | 点击 `全览` 或 `跳到最新` | 一键适配全部有效时间范围，或跳至最新提交尾部 |
| **自动跟随** | 勾选 `Auto-Follow` | 热录制期间视口自动跟随最新到达的轨迹（手动拖动/缩放查看历史后可按需开关） |
| **放置游标 A** | 在泳道上**单击左键** | 放置游标 A 并触发精确点解码查询 |
| **放置游标 B** | 再次单击，或 **`Shift + 单击`** | 放置游标 B，底部状态栏实时计算 Δt 与区间连续性 |
| **微调游标 A / B** | 将鼠标移近游标线（±7 px 内）按住左键**左右拖动** | 实时拖动游标并刷新对应时刻的上下文与事件摘要 |
| **清除游标** | 点击工具栏 `清除 A/B` | 同时清除游标 A 和 B |
| **跳至事件列表** | 放置游标 A 后，点击游标信息栏的跳转按钮 | 直接在 `Contexts & Events → 事件列表` 中高亮定位该时刻对应的原始事件 |

### 5.4 时间单位、多段（Segment）与缺口诊断

1. **时间单位切换**：支持按数据完备度在以下单位间切换：
   - `ns`（绝对纳秒，需已锚定有效系统主频）
   - `relative-ns`（段内相对纳秒）
   - `absolute-ticks`（绝对目标时钟周期）
   - `relative-ticks`（段内相对周期，即使缺少主频或未锚定仍可精确查看）
2. **多段（Segment）与启动代次（BootGeneration）**：
   - 当发生目标复位、主频变更、时间戳不可信回绕或数据缺口时，Orbit 会自动切分为新的可信段（`Seg #N (boot M)`），并在下拉框中提供「全部锚定段」或单段切换。
3. **缺口（Gap）与丢包透明披露**：
   - 工具栏状态区严格区分五类异常边界：`target-overflow`（目标端 RTT 缓冲满溢出）、`host-drop`（主机接收/排队丢弃）、`control-pause`（调试暂停/控制介入）、`decode-sync-loss`（字节流失步后重新找到同步帧）、`storage-failure`（落盘失败）。
   - 若游标 A 与 B 跨越了缺口或不同启动段，Orbit 会明确提示「连续性阻断」，拒绝编造跨越缺口的虚假连续耗时。

---

## 6. Contexts & Events：统计、Marker、事件流与 Trace 终端

切换到 **RTOS** 面板 → **Contexts & Events** 页签，对当前录制或离线打开的归档进行深度定量分析。

### 6.1 统计范围、精度模式与 CPU Load 分箱图

1. **三种统计范围来源**（顶部左端芯片切换）：
   - **Trace 视口**：仅统计当前 Trace Timeline 屏幕可见的时间窗口（实时联动，缩放泳道即重算）。
   - **A/B 选区**：精确统计 Trace Timeline 中游标 A 与 B 之间的区间（适合针对单次故障或单周期控制做切片分析）。
   - **全部范围**：统计当前选中段或全部锚定段。
2. **聚合精度模式**：
   - **`精确聚合 (exact)`**：逐包完整重建每一条激活、抢占与 Ready 等待延迟。
   - **`近似 LOD (approx)`**：当选择范围覆盖超大数据量、触发单次扫描预算上限时自动降级，仍保留 CPU Load 分箱趋势图；在 Trace Timeline 中缩放缩小视口即可切回精确聚合。
3. **CPU Load 有界分箱图**：
   - 在「上下文统计」与「Markers」子页签顶部展示分箱堆叠柱状图，按颜色区分 **Task**、**ISR(独占)**、**Scheduler**、**Idle** 与 **Unknown/缺口**。
   - **悬停交互**：移动鼠标到任意分箱，上方实时展示该箱的时间区间、Active%/ISR%/Idle%/Unknown%、占比最高的**主上下文**以及是否包含缺口。
   - **点击下钻**：**直接单击任意异常高负载分箱，界面会自动跳转回 Trace Timeline 并放大定位到该分箱对应的时间窗口！**

### 6.2 上下文统计（Contexts）

支持按类型芯片（`全部`、`Task`、`ISR`、`Idle`、`Sched`、`Timer`）筛选，并支持搜索任务名、TCB 地址或 IRQ 编号。表格包含 7 列（支持多列点击排序）：

| 列名 | 统计含义与工程解读 |
| --- | --- |
| **类型** | `Task` / `ISR` / `Idle` / `Sched` / `Timer` |
| **上下文 / 实例** | 名称、TCB 地址；若同一 TCB 地址被删除后复用了新任务，会以 **`#g2` 等代次徽章**区分，避免混算。行内点击 **「事件」** 按钮可一键带条件跳转到事件列表。 |
| **独占 CPU 时间 / 占比** | 扣除被高优先级任务或中断抢占的时间后，真正消耗在该上下文的 CPU 时间及占窗口百分比（有缺口时同时展示可信域占比）。**注：软件 Timer 回调运行在宿主任务切片内，标注「不计入CPU%」避免重复计算。** |
| **完整激活次数** | 起止完全落入统计窗的完整运行次数，同时单列 `+N跨界`（跨窗口边界）与 `+N不完整`（被缺口打断），绝不拿残缺样本凑数。 |
| **独占 Min / Avg / Max** | 单次完整激活的最小 / 平均 / 最大**纯执行耗时**。 |
| **包含耗时 (含嵌套/抢占)** | 从进入该上下文到退出期间的墙钟耗时（含期间被抢占或嵌套中断的耗时），悬停可查看累计被抢占次数与总被抢占时长。 |
| **Ready 延迟 Min / Avg / Max** | **（仅 Task）** 任务从进入就绪态（`TASK_START_READY`）到真正获得 CPU 运行（`TASK_START_EXEC`）的调度等待延迟，是诊断高优先级任务饥饿或响应抖动的黄金指标。 |

### 6.3 Markers（自定义打点分析）

如果固件使用 `SEGGER_SYSVIEW_OnUserStart(id)` / `SEGGER_SYSVIEW_OnUserStop(id)` 或点打点 `SEGGER_SYSVIEW_Mark(id)` 对关键算法（如 PID 计算、DMA 回调、CAN 帧处理）打点，可在 **Markers** 子页签查看：
- `Marker ID (M#N)`、`名称与来源`、`完整区间数（含跨界/不完整）`、`单次耗时 Min / Avg / Max`、`累计耗时`、`点事件 (EX_MARK) 次数`、`关联上下文`。

### 6.4 事件列表（Events）与参数解码器

切换到 **事件列表 (Events)** 子页签，可对百万级原始 SystemView 事件进行虚拟滚动浏览与逐包检查：

1. **多维过滤**：
   - 8 个分类芯片：`全部`、`任务/调度`、`中断 (ISR)`、`FreeRTOS API`、`Markers`、`终端输出`、`系统/资源`、`未知/异常`。
   - 关键字搜索：支持搜事件名、任务/IRQ 名、API 名、地址或终端文本。
   - **仅看诊断**复选框：一键筛出未知事件、地址无法解析、参数不匹配或断段告警事件。
   - **上下文标签**：从上下文统计页点击「事件」跳入时自动激活，点击 `×` 可清除。
2. **海量表快速导航与导出**：
   - 支持 **「首行」**、**「末行」**、输入行号后按回车或点击 **「跳行」**，以及点击 **「导出 CSV」** 将当前范围与筛选条件下的全部匹配事件流式导出。
3. **右侧事件详情与 FreeRTOS API 参数表**：
   - 单击任意事件，右侧展示完整身份信息、时间域、原始字节偏移与 **FreeRTOS API 参数解码表**（逐行列出 `参数名`、`类型`、`原始值`、`解析/名称/语义`、`来源/状态`）。
   - 双击事件行或点击 **「定位Trace」** / **「定位 Trace Timeline」**，立即在泳道中居中高亮该事件。

### 6.5 Trace 终端与异常/坏包诊断抽屉

切换到 **Trace 终端** 子页签，查看固件通过 `SEGGER_SYSVIEW_Print` / `PrintfTarget` / `Warn` / `Error` 输出的日志流：

- **过滤与续行合并**：支持按 `全部`、`LOG`、`WARNING`、`ERROR` 过滤及关键字搜索；勾选 **「合并追加」** 会自动将同上下文、连续段内的 `SEGGER_SYSVIEW_FLAG_APPEND` 续行合并为完整一行（严格不跨缺口或重启代次拼接）。
- **一键回溯**：每行终端日志均带时间戳、段号（`b0:s1`）、触发上下文（含嵌套 ISR 深度 `[嵌套d=2]`），点击 **「事件详情」** 或 **「定位Trace」** 即可回溯日志打印瞬间对应的任务调度上下文。
- **异常与坏包诊断抽屉**：点击工具栏 **「异常与坏包诊断 (N)」** 展开右侧抽屉，集中审视解码坏包、缓冲超限、嵌套深度异常与断段记录。

---

## 7. 跨面板时间联动：RTOS Trace ↔ 变量 TIMELINE

Orbit 将底部 **RTOS Trace Timeline** 与 **变量 TIMELINE** 打通，让「物理量/控制变量变化」与「软件任务/中断调度」同屏对齐分析。

### 7.1 实时同会话联动

1. 在同一次 Orbit 调试会话中，同时开启 **变量 TIMELINE** 采样与 **RTOS Trace Timeline** Continuous 录制。
2. 在 **Trace Timeline** 上放置游标 A（或 A 与 B），点击工具栏 **「定位到变量 TIMELINE」**；或者在 **变量 TIMELINE** 放置游标后点击 **「定位到 RTOS Trace」**。
3. 目标面板会自动切换视口并同步放置对应游标，同时两侧保留各自独立的 `Auto-Follow` 开关。
4. **精度提示**：实时关联仅在**同一会话、同一有效时钟区间**内生效。由于 RTT 交付与探针变量采样存在各自链路延迟，界面显示「近似联动」时代表存在未标定上界的传输延迟，判断因果关系时需结合延迟窗口综合确认。

### 7.2 离线记录手动对齐（单点 A / 双点 A+B 校准）

当你在调试结束后分别打开了保存的变量 TIMELINE `.csv` 与 RTOS Trace 归档，可通过共同物理特征事件进行精确手动对齐：

1. **单点偏移对齐（仅用游标 A）**：
   - 在 **变量 TIMELINE** 中用 **游标 A** 标出某个已知特征点（例如某标志变量从 0 跳变为 1 的瞬间，或周期信号上升沿）。
   - 在 **RTOS Trace Timeline** 中用 **游标 A** 标出同一已知事件（例如对应的触发任务唤醒、ISR 进入或自定义 Marker）。
   - 在 Trace Timeline 点击 **「手动对齐」**，即可建立偏移映射并支持后续双向跳转。
2. **双点比例校准（同时使用游标 A 与 B）**：
   - 若两侧同时也用 **游标 B** 标出了第二个共同特征事件，点击 **「手动对齐」** 后，Orbit 会用 `(A_trace, A_var)` 与 `(B_trace, B_var)` 两对游标自动拟合时钟偏移与频率比例，消除两个时钟源之间的微小频差。
3. **区间边界说明**：目标复位、运行中动态改变系统主频或出现 Trace 缺口会拆分可用时间区间，对齐校准只在各自连续区间内有效。

---

## 8. 录制归档、离线回放与数据导出

### 8.1 `orbit-trace-v1` 归档保存、打开与损坏恢复

- **保存录制**：在 Trace Timeline 点击 **「保存录制」**，选择一个**新的空目录**，Orbit 会将已校验提交的前缀完整保存为 `orbit-trace-v1` 归档目录（安全防误覆盖：禁止覆盖源目录或非空目标目录）。
- **归档目录结构**：
  - `manifest.json`：归档格式版本、会话/目标元数据、主频、段列表与 `rawSha256` 校验摘要
  - `raw.otbin`：原始 SystemView 二进制字节流
  - `data.otd`：解码与重建数据块
  - `journal.otj`：提交日志与 CRC32 校验记录
  - `index.otidx`：时间/字节范围分块索引（加速百万级查询）
- **离线打开与容错恢复**：
  - 无需连接任何探针或开发板，在 Trace Timeline 或 Contexts & Events 点击 **「打开录制」**，选择归档目录或其中的 `manifest.json` 即可回放全套视图。
  - 若录制曾因主机异常断电、磁盘写满或探针突然掉线中断，打开时 Worker 会逐帧核验 CRC32 与 SHA-256，并明确区分三种恢复结果：`rebuilt-bad-index`（索引损坏已自动重建）、`recovered-prefix-bad-chunk`（坏块前已校验前缀精确截断保留）、`recovered-interrupted`（未正常关闭的已提交前缀恢复），且支持另存为干净副本。

### 8.2 导出 `.bin` 原始流与 39 列 `.csv` 表格

#### 导出 `.bin`
- 点击 Trace Timeline 的 **「导出 .bin」**，仅导出经 `journal.otj` 与 CRC32 校验通过的连续原始 SystemView 字节流（剔除未提交尾部或损坏段之后的字节）。采用原子无覆盖写入，禁止覆盖已有文件。

#### 导出 `.csv`（支持百万级有界流式导出）
Orbit 提供三个导出入口：
1. Trace Timeline → **「导出视口 CSV」**（当前可视范围）
2. Trace Timeline → **「导出选区 CSV」**（游标 A–B 区间）
3. Contexts & Events → Events → **「导出 CSV」**（当前时间范围 + 所有活动筛选条件下的全部匹配事件）

**CSV 格式规范与安全机制**：
- 后台 Worker 分块流式写出，绝不把百万行整包载入 Webview 导致卡顿或 OOM。
- 采用 `LF (\n)` 行尾、标准 RFC 4180 引号转义与原子无覆盖发布；对来自目标流或外部元数据的文本字段自动中和 `=`、`+`、`-`、`@` 等电子表格公式注入前缀，数值列保持原始数值。
- **固定输出 39 列**，方便 Python / MATLAB / Excel 自动化脚本稳定解析：

| 字段分组 | 包含列名（共 39 列） |
| --- | --- |
| **归档与查询元信息 (9 列)** | `recordId`, `archiveFormat`, `archiveState`, `recoveryDisposition`, `exportSource`, `queryUnit`, `rangeStart`, `rangeEnd`, `filterSummary` |
| **时间段与可靠性 (8 列)** | `bootGeneration`, `segmentId`, `segmentReliability`, `timeDomain`, `timeAnchorStatus`, `sysFreqHz`, `timestampWrapped`, `uncertaintyFlags` |
| **事件定位与协议身份 (8 列)** | `eventKey`, `packetIndexInSegment`, `streamByteOffset`, `byteLength`, `eventId`, `eventName`, `category`, `schemaReliability` |
| **精确时间戳 (4 列)** | `deltaTicks`, `relTicks`, `absTicks`, `ns` |
| **上下文与中断嵌套 (6 列)** | `contextKind`, `contextKey`, `contextLabel`, `contextLabelSource`, `isrDepth`, `nestedIsr` |
| **文本与原始负载 (4 列)** | `summary`, `terminalText`, `diagnostics`, `rawPayloadHex` |

### 8.3 关于 SEGGER `.SVDat` 格式的说明

Orbit 当前**不支持** SEGGER `.SVDat` 格式的导入与导出（工具栏会固定显示 `− .SVDat 未支持`，界面及 API 均会显式拒绝 `.SVDat` 路径）。请统一使用 **Orbit `orbit-trace-v1` 归档目录**（离线完整回放）、**`.bin`**（原始字节流）或 **`.csv`**（结构化二次分析）。

---

## 9. 典型工程故障排查实战流程

### 场景 A：排查任务栈溢出隐患与堆内存缓慢泄漏

1. 让设备在典型高负载业务下运行一段时间。
2. 打开 **RTOS → Tasks & Objects → 任务**，暂停目标（或直接在线）点击顶部 **「扫描全部栈」**。
3. 点击 **「栈水位 / 容量」** 表头降序排列，优先关注进度条变红（`> 85%`）的任务；点击该任务行在右侧确认 `栈起点 / 终点`、`未用峰值` 和扫描是否完整。
4. 切换到 **「定时器与堆」** 子页签，点击 **「刷新定时器与堆」**，核对 `历史最低剩余 (minimumEverFreeBytes)` 是否逼近危险线；每隔 1 分钟刷新一次，对比 `成功分配 / 释放` 的差值与 `当前剩余` 是否持续走低，即可快速确认是否存在堆泄漏。

### 场景 B：定位互斥锁死锁与优先级反转

1. 发现业务卡死时，点击调试工具栏的 **「暂停」** 让 CPU 停下，打开 **Tasks & Objects** 点击 **「刷新」**（确认顶部徽章为 `halted-consistent`）。
2. 若 **队列与锁** 页签旁出现 **⚠ 候选等待环**，直接切换进去查看顶部红色告警横幅中的完整环路（如 `TaskA → [Mutex_I2C] → TaskB → [Mutex_SPI] → TaskA`）。
3. 若未构成死锁但高优先级任务响应变慢，在 **任务** 页签检查 **优先级** 列是否存在类似 `5 (base 2)` 的优先级继承标记，选中该任务并在右侧点击它「持有」的互斥锁跳入对象视图，即可看到哪些高优先级任务正阻塞在它的等待队列中。

### 场景 C：分析 CPU 负载飙升与任务调度延迟抖动

1. 开启 SystemView **Continuous** 录制覆盖卡顿时段，停止录制后切到 **Contexts & Events**。
2. 观察顶部 **CPU Load 有界分箱图**，找到红色（ISR）或蓝色（Task）异常偏高的分箱，**直接点击该分箱**跳回 Trace Timeline 放大检查。
3. 切回 **Contexts & Events → 上下文统计**（范围保持为 `Trace 视口`）：
   - 按 **「独占 CPU 时间 / 占比」** 排序找出热点任务/中断；
   - 按 **「Ready 延迟 Min / Avg / Max」** 排序找出最大等待延迟异常的任务；
   - 点击热点上下文行内的 **「事件」** 按钮，查看该任务在异常窗口内究竟高频调用了哪些 FreeRTOS API 或触发了哪些中断。

### 场景 D：关联定位“控制变量波形毛刺”的软件根因

1. 同时运行 **变量 TIMELINE**（如采样电机电流/PID 输出）和 **RTOS Trace Timeline**。
2. 在 **变量 TIMELINE** 中发现波形毛刺或阶跃异常，使用 **游标 A / B** 框住异常前后区间，点击 **「定位到 RTOS Trace」**。
3. 切到 **RTOS Trace Timeline** 查看同一时间窗：检查是否在毛刺瞬间发生了高优先级通信中断抢占、控制任务 Ready 延迟超标、软件定时器回调阻塞，或 `Trace 终端` 打印了告警日志。

---

## 10. Automation API 与 MCP 自动化接入

当需要在自动化回归测试脚本或 AI 助手（MCP）中调用 RTOS 诊断能力时，先在 VS Code 设置中开启：

```jsonc
{
  "orbit.automation.enabled": true,
  "orbit.automation.allowedScopes": [
    "read",
    "record",
    "rtt.control" // 仅在需要通过 API/MCP 自动启停 SystemView 录制时添加
  ]
}
```

### 接口与权限对照表

| API 方法 | MCP 工具名 | 所需 Scope | 说明 |
| --- | --- | --- | --- |
| `orbit.rtos.capabilities` | `orbit_rtos_capabilities` | `read` | 查询活动会话的 RTOS 解析能力 |
| `orbit.rtos.snapshot` | `orbit_rtos_snapshot` | `read` | 获取 FreeRTOS 任务/对象/定时器/堆快照（读取前需检查 `consistency` 与 `reason`） |
| `orbit.trace.list` | `orbit_trace_list` | `read` | 列出当前录制及已在 RTOS 面板打开授权的离线归档 |
| `orbit.trace.status` | `orbit_trace_status` | `read` | 查询 `recordId` 状态、计数器、已提交字节及时间段（`includeSegments: true`） |
| `orbit.trace.events` | `orbit_trace_events` | `read` | 按半开区间 `[start, end)`（十进制字符串）分页拉取事件，单页最多 200 条，用 `nextOffset` 翻页 |
| `orbit.trace.statistics` | `orbit_trace_statistics` | `read` | 查询区间上下文统计、聚合精度与缺口信息 |
| `orbit.trace.start` | `orbit_trace_start` | `record` + `rtt.control` | 启动目标录制（需传当前会话代次与唯一 `idempotencyKey`） |
| `orbit.trace.stop` | `orbit_trace_stop` | `record` + `rtt.control` | 停止当前会话所拥有的活动录制 |

### Node.js 客户端离线分析示例

```js
// 1. 查询已在 RTOS 面板中打开的离线归档（无需连接目标板）
const page = await client.traceRecordings('offline');
const archive = page.items[0];

// 2. 获取分段信息（includeSegments = true）
const record = await client.traceStatus(archive.recordId, true);
const segment = record.segments[0];

// 3. 构造半开区间 [start, end)（相对 tick 需同时提供 bootGeneration 与 segmentId）
const window = {
  recordId: record.recordId,
  unit: 'relative-ticks',
  bootGeneration: segment.bootGeneration,
  segmentId: segment.segmentId,
  start: segment.minRelativeTicks,
  end: String(BigInt(segment.maxRelativeTicks) + 1n),
};

// 4. 分页读取事件并获取统计
const firstPage = await client.traceEvents({ ...window, limit: 50 });
const stats = await client.traceStatistics(window);
```

> 更多 Python SDK 与完整 Schema 说明，请参阅仓库文档 [`docs/api/orbit-automation-api.md`](../../docs/api/orbit-automation-api.md#freertos-and-systemview)。

---

## 11. 常见错误码与问题排查速查表

| 面板提示 / 错误码 | 常见原因 | 排查与解决步骤 |
| --- | --- | --- |
| `DwarfUnavailable` | 加载的 ELF 缺少 `.debug_info` 或被 `strip` | 检查构建脚本开启 `-g`/`-g3`，确认 `launch.json` 的 `program` 指向未裁剪的 ELF。 |
| `RtosNotDetected` | ELF 中未找到 `pxCurrentTCB`、`uxCurrentNumberOfTasks` 或 `pxReadyTasksLists` | 确认工程链接了 FreeRTOS 且调度器代码未被链接器回收；确认 `arm-none-eabi-nm` / `objdump` 在 `PATH` 中。 |
| `LayoutIncomplete` / `LayoutAmbiguous` | 缺少关键内核类型定义，或同名类型在多编译单元冲突无法唯一归属 | 检查是否使用标准 FreeRTOS 源码及 `-gdwarf-4` 调试格式；查看「诊断」抽屉中的具体缺漏字段说明。 |
| `UnsupportedCapability` | 目标芯片型号未在设备库中匹配到有效 RAM 范围，或对应模式不受支持 | 在 `launch.json` 正确设置 `device`（如 `STM32H723VG`）；悬停顶部能力芯片查看具体原因。 |
| `NoActiveSession` | 尚未启动 Orbit 调试，或会话已终止 | 启动 Orbit 调试会话并让固件运行过初始化代码后再执行探测或刷新。 |
| `RttChannelUnavailable` / `SysView` 未发现 | 固件未编入 SystemView、尚未运行到 `SEGGER_SYSVIEW_Conf()`、被入口断点拦住，或通道名不是 `SysView` | 确认使用了带 SystemView 的 ELF，点击「继续」越过 `main` 断点，确认 `_SEGGER_RTT` 未被优化且通道名正确。 |
| `TargetAlreadyRecording` | 固件在启动时主动调用了 `SEGGER_SYSVIEW_Start()` | 若使用 Continuous 模式由 Orbit 控制启停，请移除固件启动阶段的主动 `Start()` 调用。 |
| 快照显示 `partial` 或 `BudgetExceeded` | 运行态读取期间内核链表恰好被任务切换改写，或对象/栈扫描达到单帧字节/时间预算 | 暂停目标后重新点「刷新」获取 `halted-consistent`；无线探针建议关闭 `Live含扩展` 并适当增大 Live 刷新周期。 |
| 栈水位 / CPU% 列显示「不可用」或 `—` | 未开启 `configRECORD_STACK_HIGH_ADDRESS` / `configGENERATE_RUN_TIME_STATS`，或未配置 `rtosSnapshotPort`，或首帧尚未形成双帧差分 | 检查 `FreeRTOSConfig.h` 宏，并在 `launch.json` 中补充 `rtosSnapshotPort`；CPU% 需要至少两次有效刷新建立差分区间。 |
| Trace 出现 `target-overflow` 缺口 | 目标端 `SysView` RTT Up 缓冲区过小，或事件产生速率超过探针读取吞吐 | 增大 `SEGGER_SYSVIEW_RTT_BUFFER_SIZE`（如 8192 或 16384 B），减少高频冗余 `PrintfTarget`，必要时改用 Single-Shot 或更高 SWD 时钟。 |
| 保存归档或导出 CSV/BIN 被拒绝 | 目标目录非空、目标文件已存在，或扩展名为 `.SVDat` | 选择全新的空目录保存归档，使用新文件名导出 `.bin` / `.csv`（不支持 `.SVDat` 且出于数据安全禁止覆盖）。 |
