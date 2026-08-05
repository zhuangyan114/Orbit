# Orbit for VS Code — 项目架构图

> 本图描述 Orbit(ozone 调试类型)扩展的完整架构,包括 3 个进程边界、目标访问双通道、Webview、插件 API 与 MCP。
> 图中灰色虚线节点为**未接线(遗留/未被 `extension.ts` 实例化)**组件。
> 维护时应与 `AGENTS.md` 中的架构约束(单目标拥有者、调度优先级、DAP 路由契约)保持一致。

```mermaid
flowchart TD
    classDef ext   fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
    classDef host  fill:#f0f9ff,stroke:#0284c7,color:#0c4a6e
    classDef dap   fill:#f0fdf4,stroke:#16a34a,color:#14532d
    classDef nat   fill:#fefce8,stroke:#ca8a04,color:#713f12
    classDef legacy fill:#fdf2f8,stroke:#db2777,color:#831843
    classDef unwired fill:#f3f4f6,stroke:#9ca3af,color:#4b5563,stroke-dasharray:6 4
    classDef blocked fill:#fef2f2,stroke:#ef4444,color:#7f1d1d

    %% ==================== 外部 ====================
    VSCodeUI["VS Code 调试 UI<br/>DebugAdapter · 断点/步进/变量视图"]:::ext
    MCP["MCP Server<br/>Releases/mcp/ozone-mcp-server.js<br/>(stdio · HTTP /rpc 客户端)"]:::ext
    JLinkHW["J-Link 硬件<br/>USB / SWD"]:::ext
    JLinkExe["JLink.exe<br/>(烧录子进程)"]:::ext
    ArmTools["arm-none-eabi-nm / objdump / addr2line<br/>(外部 GNU 工具链)"]:::ext
    WFrontend["Watch 前端 (React iframe)<br/>src/webview/watch/app.tsx"]:::ext
    TFrontend["Timeline 前端 (React iframe)<br/>src/webview/timeline/app.tsx"]:::ext

    %% ============ ① 扩展宿主进程 ============
    subgraph HOST["① VS Code 扩展宿主进程 (extension host)"]
        direction TB
        ExtEntry["extension.ts — 激活入口<br/>activate() · 命令注册 · 调试会话事件"]:::host
        HostBackend["OzoneBackend (扩展宿主实例)<br/>src/ozone-backend/commander.ts"]:::blocked
        WatchTree["Watch TreeView<br/>WatchProvider (变化高亮)"]:::host
        WatchWV["Watch Webview<br/>WatchWebviewProvider · 加载 dist/watch.js"]:::host
        TimelineWV["Timeline Webview<br/>TimelineWebviewProvider · 加载 dist/timeline.js"]:::host
        DSM["DataSamplingManager<br/>remote(经 DAP) / local(宿主直连) 双模式"]:::host
        PluginApi["PluginApiServer<br/>127.0.0.1 随机端口 · Bearer 认证<br/>写出 plugin-api-endpoint.json"]:::host
        Router["RuntimeRouter<br/>活跃 ozone 会话时强制走 customRequest"]:::host
        WaveRec["WaveRecorder"]:::host
        ExpSvc["ExperimentService"]:::host
        RttTerm["RTT 输出终端 (伪终端)<br/>消费 ozoneRttOutput 事件"]:::host

        subgraph UNWIRED["遗留组件 (未接线 — 未实例化)"]
            U1["SessionManager<br/>src/session/session-manager.ts"]:::unwired
            U2["DebugWebviewProvider / 旧版 app.tsx<br/>src/webview/"]:::unwired
            U3["breakpoints/ BreakpointManager"]:::unwired
            U4["ai/ AIProviderManager"]:::unwired
            U5["debug-manager.ts<br/>Ozone.exe --jdebug 启动器"]:::unwired
        end
    end

    %% ============ ② DAP 适配器进程 ============
    subgraph DAP["② DAP 适配器进程 (dist/debugadapter.js)"]
        direction TB
        DapEntry["debugadapter.ts — DAP 入口<br/>Content-Length 帧解析 · 生命周期"]:::dap
        DapSession["DapSession<br/>src/debug/dap-session.ts<br/>断点/步进/RTT 轮询/数据采样/连接监视"]:::dap
        DapBackend["OzoneBackend (DAP 实例)<br/>src/ozone-backend/commander.ts<br/>唯一目标所有者"]:::dap
        Selector["SessionTargetSelector<br/>src/ozone-backend/session-target-channel.ts<br/>native / legacy 二选一"]:::dap
        NativeCh["ExperimentalCppJLinkChannel<br/>src/ozone-backend/cpp-jlink-channel.ts"]:::nat
        Scheduler["NativeScheduler<br/>control &gt; watch &gt; timeline &gt; background"]:::nat
        LegacyCh["LegacyJLinkTargetChannel"]:::legacy
        JLinkDLL["JLinkDLL (koffi)<br/>src/ozone-backend/jlink-dll.ts"]:::legacy
        Symbols["jlink-symbols.ts<br/>ELF 符号 / DWARF / 行号映射"]:::dap
        Flasher["flasher.ts"]:::dap
        PRtLog["p-rtlog-decoder.ts<br/>P-RTLog 令牌解码"]:::dap
    end

    %% ============ ③ Native Helper 子进程 ============
    subgraph HELPER["③ Native Helper 子进程 (orbit-jlink-helper.exe)"]
        direction TB
        HelperMain["main.cpp — JLinkChannel<br/>JSON-lines RPC 主循环<br/>hello 握手 · 能力协商 (协议 v2)"]:::nat
        HelperDLL["LoadLibraryW(JLink_x64.dll)<br/>GetProcAddress 函数指针解析"]:::nat
        HelperStep["指令级步进<br/>stepInto / Over / Out (Thumb 解码)"]:::nat
        HelperBP["6 槽位硬件断点"]:::nat
        HelperRTT["RTT 终端读写"]:::nat
    end

    %% ==================== 连接 ====================
    %% DAP 协议链路
    VSCodeUI -- "DAP 协议<br/>(Content-Length stdio)" --> DapEntry
    DapEntry --> DapSession
    DapSession -- "OzoneCommand.execute()" --> DapBackend
    DapBackend --> Selector
    DapBackend -- "loadSymbols (connect 后预加载)" --> Symbols
    DapBackend --> Flasher
    DapSession --> PRtLog

    %% 目标通道双模式
    Selector -- "kind = native" --> NativeCh
    Selector -- "kind = legacy" --> LegacyCh
    NativeCh --> Scheduler
    Scheduler -- "JSON-lines RPC (串行)" --> HelperMain
    HelperMain --> HelperStep
    HelperMain --> HelperBP
    HelperMain --> HelperRTT
    HelperMain --> HelperDLL
    HelperDLL -- "调用 J-Link API" --> JLinkHW
    LegacyCh --> JLinkDLL
    JLinkDLL -- "koffi 同进程加载 JLink_x64.dll" --> JLinkHW

    %% 外部工具
    ArmTools --> Symbols
    Flasher -- "spawn" --> JLinkExe
    JLinkExe -- "烧录" --> JLinkHW

    %% 宿主内部
    ExtEntry --> HostBackend
    ExtEntry --> WatchTree
    ExtEntry --> WatchWV
    ExtEntry --> TimelineWV
    ExtEntry --> PluginApi
    ExtEntry --> RttTerm
    PluginApi --> Router
    Router --> WaveRec
    Router --> ExpSvc

    %% Webview 通信 (postMessage)
    WatchWV -- "postMessage<br/>evaluateWatches / watchResults" --> WFrontend
    TimelineWV -- "postMessage<br/>samples / addExpression" --> TFrontend

    %% 跨进程:宿主 ⇄ DAP (经 DAP stdio 通道)
    WatchWV -- "customRequest 'dataSample' / setWatches" --> DapSession
    WatchTree -- "customRequest 'dataSample'" --> DapSession
    DSM -- "customRequest 'dataSamplingStart'" --> DapSession
    DapSession -- "事件 ozoneDataSamples (0.2ms 采样)" --> DSM
    DapSession -- "事件 ozoneRttOutput / ozoneClearDebugConsole" --> RttTerm
    Router -- "活跃会话: customRequest<br/>getTargetState / dataSample / setWatchValue" --> DapSession

    %% 宿主后端的阻塞与回退
    Router -. "无 DAP 会话时回退" .-> HostBackend
    HostBackend -. "ozone 会话激活时被 localTargetAccessBlocked 阻塞" .-> JLinkHW

    %% 插件 API
    MCP -- "HTTP POST /rpc (Bearer)<br/>端点发现: plugin-api-endpoint.json" --> PluginApi
```

## 分层说明

### 进程模型(3 个进程)

| 进程 | 入口 | 职责 |
|---|---|---|
| 扩展宿主 | `src/extension.ts` → `dist/extension.js` | UI(Watch/Timeline webview)、插件 API HTTP 服务器、宿主侧 `OzoneBackend` |
| DAP 适配器 | `src/debugadapter.ts` → `dist/debugadapter.js` | 通过 stdio `Content-Length` 帧与 VS Code 通信;持有**唯一目标所有者** |
| Native Helper | `native/jlink-helper/src/main.cpp` → `orbit-jlink-helper.exe` | 独立子进程,内部加载 `JLink_x64.dll`(DLL 不进入 Node 进程) |

- `OzoneBackend` 在扩展宿主与 DAP 中各实例化一份,行为差异由构造参数决定(`sessionTarget` / `localTargetAccessBlocked`)。
- **DAP 会话激活期间 DAP 拥有目标访问权**:扩展宿主后端被 `localTargetAccessBlocked` 回调拒绝;`SessionManager` 在会话激活时不得连接宿主后端。`ozone.debug` 命令先 `disconnect` 释放宿主连接,再启动 DAP。

### 目标通道双模式(每会话单一物理 J-Link 拥有者)

- **native**(默认优先):`ExperimentalCppJLinkChannel` 派生 helper 子进程,JSON-lines RPC(`hello` 握手 + 能力协商,协议 v2),所有调用经 `NativeScheduler` 按 `control > watch > timeline > background` 严格串行化;control 请求暂停 timeline/background。
- **legacy**:`LegacyJLinkTargetChannel` 通过 koffi 将 `JLink_x64.dll` 加载进适配器进程。仅在 native 启动失败时(或 `auto` 模式)回退;**已连接的 native owner 永不热切换**;`NativeOwnerLost` 时清空 owner 并要求重启会话,失败回退不留任何 owner。
- 安全规则:6 槽位索引硬件断点、无 `ExecCommand("SetBP ...")`、`disconnect` 不得以 close/open 做 owner 切换。

### 四条主要数据流

1. **Watch 求值/轮询**:Webview → `WatchWebviewProvider` → `session.customRequest('dataSample')` → `DapSession.handleDataSample` → `OzoneBackend.execute(evaluateExpression)` → 目标通道;宿主 `startWatchPolling` 按 `orbit.watchPollIntervalMs` 定时走同一路径并同步推给 TreeView 与 Webview。
2. **Timeline 采样**:`DataSamplingManager` 双模式 —— remote(DAP 侧 0.2ms 高频采样,16ms 经 `ozoneDataSamples` 事件推送,采样期间暂停 RTT 轮询)/ local(无 DAP 会话时宿主 `setTimeout` 循环 `evaluateExpression`)。
3. **RTT Log**:`DapSession.startRttLogPolling`(`rttPollIntervalMs`)→ `readRtt` → 经 `ozoneRttOutput` / `ozoneClearDebugConsole` 事件写入 RTT 伪终端;支持 p-RTLog 令牌解码与 ANSI 剥离。
4. **插件 API**:MCP(stdio)→ `POST /rpc`(Bearer)→ `PluginApiServer.dispatch` → `RuntimeRouter` → 活跃会话存在时一律 `session.customRequest`(跨进程),否则回退宿主后端。`WaveRecorder` 按 interval 采帧,`ExperimentService` 编排 read/write/wait/record。

### 遗留(未接线)组件

`SessionManager`、`DebugWebviewProvider` / 旧版 `src/webview/app.tsx`、`breakpoints/`、`ai/`、`debug-manager.ts`(Ozone.exe 启动器)未被 `extension.ts` 实例化,图中以灰色虚线标出,当前激活路径为:宿主后端 + Watch/Timeline webview + PluginApiServer + DAP 进程。

### 相关文档

- `docs/plugin-api-plan-zh.md` — 插件 API 设计
- `docs/debug-engine-refactor/` — 调试引擎重构说明
- `AGENTS.md` — 架构约束与开发流程(本图应与其保持同步)
