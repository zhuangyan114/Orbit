# 阶段 5.3：录制归档、流式 CSV 导出与 `.SVDat` 独立评估报告

- 日期：2026-11-19
- 验收基线：`cfe68e1`（阶段 5.2 已提交）
- 测试范围：Orbit 内部归档（`orbit-trace-v1`）保存/离线打开/校验与前缀恢复、Trace 视口/A-B 选区/Events 有界流式 CSV 导出、文件安全边界与取消回滚、SEGGER `.SVDat` 独立评估，以及真实隔离 VS Code 扩展开发宿主操作；本阶段不连接探针或修改 `D:/STM32/project/h7vgt6_test` / `UP`。

## 1. Orbit 原始录制归档、校验与恢复边界

### 1.1 归档格式与打开校验

Orbit 使用 `orbit-trace-v1` 目录归档（`manifest.json`、`raw.otbin`、`data.otd`、`journal.otj`、`index.otidx`、`index-spill.otidx`）：

- **格式与版本校验**：`inspectRecordingDirectory` 在 `TraceRecordingStore.open` 入口强制校对 `manifest.format === 'orbit-trace-v1'` 与 `manifest.formatVersion <= 1`（当前仅支持版本 `1`）。高版本归档（例如 `formatVersion: 999`）返回 `UnsupportedArchiveVersion` 并拒绝加载；格式不匹配返回 `UnsupportedArchiveFormat`。
- **帧级与内容哈希校验**：逐帧读取 `journal.otj` 帧头/元数据/尾校验（magic `0x4f544a31`、CRC32），并可对已提交区间 `[0, committed.rawBytes)`、`[0, committed.dataBytes)` 逐块校验 `rawCrc32` / `dataCrc32` 以及整段 `rawSha256`。
- **异常分类与精确前缀恢复**：
  - `rebuilt-bad-index`：当 `index.otidx` 缺失或损坏但 `journal.otj` 与已提交块完整有效时，不丢弃数据，直接基于 `journal.otj` 重建内存索引并允许读取全量已提交流；`saveArchive` 时同步重建干净索引。
  - `recovered-prefix-bad-chunk`：当已提交区 `raw.otbin` 或 `data.otd` 中途发生 CRC32 损坏或截断时，恢复停止在损坏帧之前的最后一个完整提交边界（例如 H723 `4,156 B` 在字节偏移 `1,395` 损坏时精确恢复 `1,388 B` 前缀，SHA-256 `1457da6b8a4567b120978cb8923f62b473043180bb79ca23451ffd46557df823`）。
  - `recovered-interrupted`：合法中断/崩溃导致的未调用 `finish()`、未提交尾部或 `journal.otj` 尾帧截断，状态标记为 `interrupted`（而非坏块 `corrupted`），在已有 `manifest.rawSha256` 且长度一致时仍校验通过。

### 1.2 路径安全、流式拷贝与失败回滚

- `saveArchive`、原始 `.bin` 导出（`exportRaw`）与 `.csv` 导出均复用真实 `TraceWorkerClient` / Worker 线程中的有界分块流式传输，不在 Webview 内存复制百万事件或整份原始文件。
- 路径安全保护：
  - 禁止覆盖既有非空目录/文件（返回 `RecordingDirectoryNotEmpty` 或 `ExportTargetExists`）。
  - 禁止源目录自保存、保存进源目录内部子目录或父级冲突目录，禁止写入符号链接目标（返回 `ExportPathConflict`）。
  - 统一拒绝 `.SVDat`（大小写不敏感，返回 `UnsupportedCapability`）。
- 写入采用同目录独占暂存文件（`wx`）与提交时原子无覆盖发布：优先同文件系统硬链接 `link(tmp, dst)`（若 `dst` 已存在则内核原子返回 `EEXIST`），底层不支持硬链接（如 `EXDEV`/`ENOTSUP`）时退回 `open(dst, 'wx')` 分块拷贝，绝不先检查再使用会替换既有目标的 `rename`，亦绝不删除并发竞争者或外部创建的既有文件；遇到 `ENOSPC`、短写（`ShortWrite`）、I/O 错误或 `AbortSignal` / `SharedArrayBuffer` 中途取消时清理自身创建的临时/半成品文件。

## 2. 有界流式 CSV 导出契约

CSV 导出在 `src/trace/trace-csv-export.ts` 与 Worker 内通过 `streamMatchedEvents` 按页分块流式输出（默认 64 KiB 刷新边界）：

- **三种导出入口**：Trace 视口（`trace-viewport`）、A/B 选区（`ab-selection`）与 Events 当前筛选/分页范围（`events-page`）。
- **固定 39 列与 LF 行约定**：记录行统一使用 LF（`\n`）作为行结束符，字段编码遵循 RFC 4180 引号转义规则；固定列如下：
  `recordId`, `archiveFormat`, `archiveState`, `recoveryDisposition`, `exportSource`, `queryUnit`, `rangeStart`, `rangeEnd`, `filterSummary`, `bootGeneration`, `segmentId`, `segmentReliability`, `timeDomain`, `timeAnchorStatus`, `sysFreqHz`, `timestampWrapped`, `uncertaintyFlags`, `eventKey`, `packetIndexInSegment`, `streamByteOffset`, `byteLength`, `eventId`, `eventName`, `category`, `schemaReliability`, `deltaTicks`, `relTicks`, `absTicks`, `ns`, `contextKind`, `contextKey`, `contextLabel`, `contextLabelSource`, `isrDepth`, `nestedIsr`, `summary`, `terminalText`, `diagnostics`, `rawPayloadHex`。
- **时间基与不确定性显式标注**：每行明确记录 `timeDomain`（`anchored-ns` / `segment-relative-ticks` / `unknown`）、`timeAnchorStatus`、`sysFreqHz` 与 `timestampWrapped`；以 `ns` 导出时自动跳过未锚定或无主频段并在结果摘要中计数；`uncertaintyFlags` 区分 `incomplete-archive`、`corrupted-prefix`、`bad-index-rebuilt`、`uncertain-segment`、`unanchored-clock`、`unknown-frequency`、`timestamp-wrapped`、`cross-gap-selection`、`target-overflow-in-window` 与 `host-drop-in-window`。
- **CSV 引号规则与公式中和边界**：
  - 逗号、LF 换行、单引号 `'`、双引号 `"` 与首尾空白完整使用 `"` 包裹并对 `"` 双写转义；单元格内 CR/CRLF 规范为 LF，其余 C0/DEL 控制字符按 `\xNN` 转义。
  - 来自记录或 `manifest.json` 等外部字符串（包括 `recordId`、`filterSummary`、`eventName`、`category`、`eventKey`、`contextKey`、`contextLabel`、`summary`、`terminalText`、`diagnostics`、`rawPayloadHex`）统一经公式注入中和：以 `=`、`+`、`-`、`@`、`\t`、`\r`、`\n` 开头，或在任意首部空白/BOM 之后紧接 `=`/`+`/`-`/`@` 的文本统一加 `'` 前缀，使其在电子表格中只作为纯字面数据展示。
  - 数值列（`bootGeneration`、`segmentId`、`sysFreqHz`、`packetIndexInSegment`、`streamByteOffset`、`byteLength`、`eventId`、`deltaTicks`、`relTicks`、`absTicks`、`ns`、`isrDepth`）保持原始数值输出。

## 3. SEGGER `.SVDat` 独立评估与延期结论

依据总计划 §5.3 例外条款，对 `.SVDat` 做了独立资料、本地文件与官方工具实测评估：

| 评估维度 | 查证来源与可观察现象 | 结论 |
|---|---|---|
| 官方手册资料 | `C:/Program Files/SEGGER/SystemView/Doc/UM08027_SystemView.pdf`（V4.10b, pp. 58–59）与 `https://doc.segger.com/UM08027_SystemView.html` 说明某些抓取/转储场景允许将裸原始流命名为 `.SVDat` 或 `.bin`，并与 GUI 中 `File -> Save Recording` 保存的带元数据录制归档相区分 | 裸流命名选项不证明官方 GUI 带元数据 `.SVDat` 归档可双向互通 |
| 本机官方样本 | `C:/Program Files/SEGGER/SystemView/Sample/*.SVDat` 开头实测包含分号 `;` 引导的文本元信息头（如 `; Version ...`、`; RecordTime ...`），其后接入二进制包流 | 与 Orbit 仅导出裸流 `.bin` 不同，不能将裸流或自定义文件冠以 `.SVDat` |
| 许可文本观察 | `C:/Program Files/SEGGER/SystemView/Doc/license/License_SystemView.txt` 标明为 `SEGGER Friendly License` / `Commercial-Use License`（SFL/CUL），其中包含非商业使用条件与第 `1(a)` 条禁止反编译/逆向工程条款（仅陈述条款文本，不作额外法律推论） | 保留可观察文本记录，不做额外许可合规断言 |
| 官方桌面工具实测 | 见 `out/rtos-stage5/acceptance-5.3/codex-official-viewer/observation.json`：使用本机 `C:/Program Files/SEGGER/SystemView/SystemView.exe`（V4.10b）尝试打开独立核对的 H723 原始 `.bin`（`h723-systemview-raw.bin`）时，在加载录制内容前即弹出 `"No Commercial-Use License \| SEGGER SystemView V4.10b"` 对话框并阻断加载（未代用户确认许可） | 当前本机许可对话框阻断了真实官方工具的双向读取核对 |

**最终决策**：阶段 5.3 保留 `.SVDat` 为**显式不可用项**（能力表 `TRACE_ARCHIVE_CAPABILITIES.svdat.available = false`；Trace 界面标明 `− .SVDat 未支持`；所有保存/导出入口拒绝 `.SVDat` 扩展名）。Orbit 仅将裸原始 SystemView 流导出为 `.bin`，并正式交付 `orbit-trace-v1` 归档目录与 LF 行分隔的 39 列 `.csv`。如后续用户具备有效商业授权与正式官方格式核验环境，再在专项或阶段 7 重新评估双向互通。

## 4. 可复跑离线与真实 VS Code 验收摘要

- **真实 H723 离线归档（`codex-h723-real-Fu3ON5`）**：原始 `4,156 B`，SHA-256 `09195102a8ef8ceafd7d6bb67b7ebe494589cfc103c2e9ef34ca532675de95e7`；保存副本后离线重开与 `.bin` 导出字节及 SHA-256 完全一致，Trace 视口 CSV 含 `670` 条记录。
- **独立恢复 Oracle（`out/rtos-stage5/acceptance-5.3/codex-oracles-WIIMu3/oracle.json`）**：
  - `corrupt-index` -> `rebuilt-bad-index`，精确恢复 `4,156 B`（SHA `09195102...`）。
  - `corrupt-raw`（偏移 `1,395` 损坏）-> `recovered-prefix-bad-chunk`，精确恢复 `1,388 B` 前缀（SHA `1457da6b8a4567b120978cb8923f62b473043180bb79ca23451ffd46557df823`）。
  - `truncated-final-journal-frame` -> `status=interrupted`、`recoveryDisposition=recovered-interrupted`，精确恢复 `4,156 B`。
  - `unsupported-version`（`formatVersion: 999`）-> 拒绝打开并返回 `UnsupportedArchiveVersion`。
- **33 包 Oracle 选区金标（`codex-events-archive-eugWS8`）**：A/B 选区 `[140, 180)`（`absolute-ticks`）导出 `15` 行、`5,440 B`（SHA-256 `b194192dc929a3f07965dbda88e0436426484139f652df91c9b482dbc9cd888b`）。
- **百万事件流式大导出（`codex-million-3fNi44`）**：
  - 离线全量导出：`1,002,005` 行（`316,864,544 B`，SHA-256 `586c85915b8a9626bbbc91791d30b3d5d3b2968a5dcefe5b7fce2f18dd282582`），耗时 `35,944 ms`，宿主峰值 RSS `498.29 MiB`；窗口 `[2700101, 2700401)` IRQ 精确导出 `10` 行。
  - 真实 VS Code Chromium Events 页面筛选 `ISR`+`IRQ` 导出 `167,000` 行（`54,814,928 B`），期间 Webview DOM 保持 `8` 行有界渲染。
- **复现命令**：
  - `node out/rtos-stage5/acceptance-5.3/verify-stage53-offline.cjs`（产物：`out/rtos-stage5/acceptance-5.3/stage53-offline-report.json`）
  - `node out/rtos-stage5/acceptance-5.3/codex-probe-archive-csv.cjs`
  - `node scripts/rtos/verify-stage53-vscode.js`（产物：`out/rtos-stage5/acceptance-5.3/vscode-ui/vscode-ui-report.json`）
