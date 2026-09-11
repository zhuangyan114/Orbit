# STM32H723VGT6 支持计划(1.1.2)

## 文档目的

为 1.1.2 版本支持 STM32H723VGT6 制定实施计划:先完成器件数据模型与 CMSIS-DAP 链路的去 F407 硬编码重构,再新增 H723 器件描述与 Flash 算法,最后在真机到货后按分级流程完成硬件验收。同时本次重构形成的"器件注册表 + 算法引用"结构是后续 F429、G4、GD32 等芯片的通用底座。

本计划不改变既有语义:

- `probe: 'cmsis-dap'` 只创建 CMSIS-DAP helper owner,不回退 J-Link。
- `flashBeforeDebug: true` 必须用当前 owner 完成 erase/program/verify;`false` 不做任何烧录动作。
- Flash 全程保持 `NativeScheduler` 的 control 临界区。
- J-Link 链路(native/legacy)只透传器件名给 J-Link DLL,本计划不改动其目标访问代码。

## 背景:当前 F407 绑定点盘点

| 位置 | 内容 |
| --- | --- |
| `src/ozone-backend/cmsis-dap-flasher.ts:42` | `STM32F407VET6` 是唯一的 `FlashTargetDefinition`,单一 `sramBase/sramSize` |
| `src/ozone-backend/cmsis-dap-flasher.ts:587,595` | 预检地址硬编码 F4:DBGMCU_IDCODE `0xE0042000`、Flash 大小寄存器 `0x1FFF7A22` |
| `src/ozone-backend/cmsis-dap-flasher.ts:274` | `defaultFlashAlgorithmPath()` 固定返回 F407 算法 bin |
| `src/ozone-backend/cmsis-dap-flasher.ts:367` | `validateTargetDeviceName` 只接受 STM32F407VET6/STM32F407VE |
| `native/cmsis-dap-helper/src/main.cpp:37` | `kStm32F4FlashSr/kStm32F4FlashCr`(0x40023C0C/10)用于算法诊断读 |
| `src/ozone-backend/commander.ts:4316` | CMSIS-DAP Watch 写地址门限硬编码 F407 SRAM(0x20000000–0x20020000) |
| `native/cmsis-dap-flash-algorithm/stm32f407_flash_algorithm.c` | F4 Flash 控制器专属算法(SER/SNB 扇区擦除、32 位 PSIZE) |
| `native/cmsis-dap-helper/src/mock_transport.{h,cpp}` | mock 目标模型按 F4 建模(DPIDR/DBGMCU/Flash 行为) |
| `scripts/cmsis-dap/verify-flash-algorithm.js` | 算法源码属性断言只覆盖 F4 |

RTT 控制块来自 ELF 符号 `_SEGGER_RTT` 或显式配置,不扫固定 RAM 范围,天然器件无关,无需改动。SVD 由用户 `svdFile`/`defaultSvdFile` 提供,仓库不内置,只需文档指路。

## H723 目标参数

CMSIS-DAP P7-1～P7-5 已在 STM32H723VGT6 + CMSIS-DAP_LU 上核实，J-Link P7-6 已于 2026-09-11 用 J-Link(V9.56, VID_1366/PID_0101, S/N 000164000406) 在同一块板上核实。长稳/断线(P7-7)暂缓。

| 参数 | 值 | 状态 |
| --- | --- | --- |
| 内核 | Cortex-M7 | — |
| Flash | 1 MiB @ `0x08000000`,单 bank,8 × 128 KiB 扇区 | P7-1/P7-4 真机 |
| 编程粒度 | 256 位(32 字节)flash word,不足需补 `0xFF` | P7-4/P7-5 真机 |
| Flash 寄存器基址 | `0x52002000`(CR/SR 偏移与 F4 完全不同) | 算法 + P7-3/P7-4 |
| DBGMCU_IDCODE | 基址 `0x5C001000`,DEV_ID `0x483`(本板 `0x10016483`) | P7-1 真机 |
| Flash 大小寄存器 | `0x1FF1E880`,读回 1024 KiB | P7-1 真机 |
| SW-DP DPIDR | `0x6BA02477`(SW-DP v2) | P7-1 真机 |
| RAM 区 | ITCM 64K @`0x00000000`;DTCM 128K @`0x20000000`;AXI SRAM(D1)320K @`0x24000000`;SRAM1-3(D2)272K @`0x30000000`;SRAM4(D3)16K @`0x38000000`;Backup 4K @`0x38800000` | RM0468; DTCM/AXI/D2/D3 DAP 可写见 P7-2 |
| Flash loader RAM | AXI SRAM `0x24000000` | P7-2/P7-3 真机 |
| 扇区擦除时长 | 末扇区实测约 1.11 s;host 默认仍为 erase 30 s / program 15 s | P7-4 真机 |

## 工作分解

### P1 器件注册表重构(TS 侧,先行)

1. `FlashTargetDefinition` 扩展:
   - `ramRegions: readonly RamRegion[]` 替代单一 `sramBase/sramSize`;`loaderRamIndex`(或显式 loader region)指定算法加载区,默认选 AXI SRAM。
   - 新增 `preflight`:DBGMCU_IDCODE 地址、DEV_ID、Flash 大小寄存器地址、期望容量;`dpIdcode` 保留。
   - 新增 `algorithm`:内置算法名或用户路径;新增 `eraseTimeoutMs`/`programTimeoutMs`(或统一 per-target 默认超时,初值按 RM 时序放大)。
2. 建立注册表 `resolveFlashTarget(device: string): FlashTargetDefinition`,按归一化器件名查找,保留 `STM32F407VE → STM32F407VET6` 别名机制;未命中返回结构化 `TargetMismatch`。
3. `validateSegmentTarget`/`calculateEraseSectors`/`planFlashRamLayout` 改用多 RAM 区;错误文案参数化为 target.name。
4. `loadFlashAlgorithm` 按 target.algorithm 选择内置 bin;内置算法属性(pageSize、preservesPageBuffer、entries)随算法元数据而非硬编码 F407 值。
5. 涉及文件:`src/ozone-backend/cmsis-dap-flasher.ts`、`session-target-channel.ts`(`flash()` 传入解析后的 target)、`commander.ts doFlash`。

### P2 H723 Flash 算法(`native/cmsis-dap-flash-algorithm/`)

1. 新写 `stm32h723_flash_algorithm.c` + `stm32h723_flash_algorithm.ld`,保持与 F4 算法相同的入口布局约定(Init/UnInit/EraseSector/ProgramPage/Verify/BKPT,BKPT 哨兵 `00 BE`)。
2. 关键差异点(实现时逐条对照 RM0468):
   - 寄存器序列:KEYR 解锁(0x45670123/0xCDEF89AB,待核实)、SER/PSIZE 对应的 H7 位域、错误清除寄存器。
   - 32 字节 flash word 编程:算法内部按 32 字节对齐补 `0xFF`,对外仍接受任意 size 的 page。
   - 128 KiB 扇区擦除的 busy/QW 等待与超时上限要单独放大。
   - cache/verify 策略:F4 曾因 I/D cache 未复位出现 `VerifyFailed`(见 `docs/bug-fix-log.md` 首条),H7 的 cache 控制方式不同,必须设计等价的失效路径后再做 Verify。
3. `scripts/build-native.ps1` 增加第二个构建目标,产出 `out/native/win32-x64/orbit-stm32h723-flash-algorithm.bin`。
4. `docs/cmsis-dap-flash-algorithm-references.md` 登记 RM0468/参考来源与许可判断(保持自研,不复制 GPL 代码)。

### P3 helper 诊断地址参数化(C++ 侧)

1. `flashAlgorithm` RPC 请求增加可选 `flashStatusAddress`/`flashControlAddress`;helper 用请求值替代 `kStm32F4FlashSr/kStm32F4FlashCr` 常量;未提供时保持 F4 现值以兼容既有会话。
2. 同步 `src/ozone-backend/cmsis-dap-helper-channel.ts`、`session-target-channel.ts`、`src/debug/dap-session.ts` 的协议字段;协议版本/能力变更按仓库规则同步。
3. `native/cmsis-dap-helper/src/mock_transport.{h,cpp}` 增加 H723 目标模型:DPIDR、DBGMCU `0x5C001000`(DEV_ID 0x483 fixture)、Flash 大小寄存器、128 KiB 扇区 + 32 字节字的擦除/编程语义。

### P4 Watch 写门禁数据化

`commander.ts doSetWatchValue` 的 CMSIS-DAP 地址检查改为当前 target 的 `ramRegions` 判定;F407 行为不变,H723 允许 DTCM/AXI/D2/D3 各区。P7-2 已确认 DTCM/D2/D3 经 DAP 可写回。

### P5 自动化测试(与 P1–P4 同步开发,不是收尾阶段)

分五层设计,每层有独立入口,层层可单独执行与定位:

**层 1:单元测试(Vitest,`npm test`)**

| 文件 | 新增用例 |
| --- | --- |
| `src/ozone-backend/cmsis-dap-flasher.test.ts` | 注册表解析与器件别名;H723 扇区计算(8 × 128 KiB);多 RAM 区 ELF 段校验(DTCM/AXI/D2 混布段放行、跨区/越界拒绝);DEV_ID/DPIDR/容量不匹配的结构化错误路径;per-target 超时默认值与算法选择 |
| `src/ozone-backend/commander-cmsis-dap.test.ts` | CMSIS-DAP Watch 写地址按当前 target 的 RAM 区放行/拒绝(H723 AXI 段放行、越界拒绝;F407 行为保持不变) |
| `src/ozone-backend/session-target-channel.test.ts`、`cmsis-dap-helper-channel.test.ts` | `flashAlgorithm` RPC 新增诊断字段(`flashStatusAddress`/`flashControlAddress`)透传;字段缺省时保持 F4 兼容值 |

**层 2:算法属性断言(`npm run test:cmsis-dap:algorithm`)**

- `scripts/cmsis-dap/verify-flash-algorithm.js` 参数化遍历 F407 与 H723 两份算法 bin;F4 断言原样保留,H723 增加独立断言组:Flash 寄存器基址/位域、32 字节 flash word 对齐与 `0xFF` 补齐、128 KiB 扇区号映射、cache 失效调用、中断保持屏蔽(对齐 F4 断言风格)。

**层 3:helper mock 冒烟(`npm run test:cmsis-dap:mock`)**

- `native/cmsis-dap-helper/src/mock_transport` 增加 H723 目标 profile:DPIDR、DBGMCU `0x5C001000`/DEV_ID `0x483`、Flash 大小寄存器、128 KiB 扇区 + 32 字节字的擦除/编程语义,与 F4 profile 并存,经场景参数(如 `--target h723`)选择。
- `scripts/cmsis-dap-smoke.js` 增加 H723 场景,走完整 DAP-02A `init/eraseSector/programPage/verify/uninit` 流,含页缓冲复用与失败路径;mock 的期望值独立维护(协议 oracle),不复用生产常量自我验证。

**层 4:协议兼容回归(`npm run test:cpp-channel:mock`)**

- helper 协议变更后必跑,确认 F407 既有会话与 cpp-channel 行为不受影响。

**层 5:硬件验证脚本(到货后启用,与前四层互不替代)**

沿用 `scripts/cmsis-dap/verify-dapXX-hw.js` 既有模式,新增脚本与 P7 验收等级一一对应,每级产出证据 JSON 到 `outputs/`:

- `verify-h723-identity-hw.js` —— P7-1 只读身份核对
- `verify-h723-ram-stub-hw.js` —— P7-2 RAM stub(含 DTCM/D2/D3 定点探针)
- `verify-h723-algorithm-init-hw.js` —— P7-3 Init/UnInit 往返
- `verify-h723-sector-hw.js` —— P7-4 授权测试扇区擦写(脚本强制要求授权参数)
- `verify-h723-flash-elf-hw.js` —— P7-5 真实 ELF 完整烧录校验(同上)
- `scripts/jlink/verify-h723-jlink-hw.js` —— P7-6 J-Link owner 连接/烧录/调试冒烟(`--authorize-flash-jlink` 授权烧录,`--skip-flash` 只连调试)
- P7-7 复用既有 dap09/dap10 家族脚本。

**package.json 入口调整**

- `test:cmsis-dap:algorithm` 保持单命令覆盖双算法;
- 新增聚合入口 `test:cmsis-dap:all` = `test:cmsis-dap:mock` + `test:cmsis-dap:algorithm` + `test:cpp-channel:mock`,供真机日之前一键回归;
- 层 5 硬件脚本不进 `npm test`,仅显式手动执行(与既有 hw 脚本约定一致)。

**每次 P1–P4 合入后的一键回归顺序**

`npm run typecheck` → `npm test` → `npm run build` → `npm run build:native` → `npm run test:cmsis-dap:mock` → `npm run test:cmsis-dap:algorithm` → `npm run test:cpp-channel:mock`。

各层结论按 skill 要求分层陈述:层 1–4 通过仅代表代码/mock/构建层通过,不替代层 5 的真机验收。

### P6 文档、默认值与发布

1. README 支持列表更新(移除"仅支持 STM32F407VET6"限制的表述,H723 标注真机验收等级)。**已完成:CMSIS-DAP P7-1～P7-5 与 J-Link P7-6 真机通过;长稳/断线 P7-7 标注未验收。**
2. `src/debug/dap-launch-config.ts:85` 过时的 F407 未实现文案更新或删除。**已删除 `cmsisDapFlashUnsupportedMessage`。**
3. SVD 指引:H723 使用 ST 官方 `STM32H723.svd`,经 `svdFile`/`defaultSvdFile` 配置。**已写入用户文档。**
4. 器件默认值(`STM32F407VG` 各处)保持不变,文档说明 H723 需显式设置 `device`。**默认值未改。**
5. `package.json` 1.1.1 → 1.1.2,打包 vsix 进 `Releases/`。**本版发布包含 CMSIS-DAP 与 J-Link 两条 H723 链路。**
6. J-Link 器件名口径:J-Link 链路把 `device` 原样交给 DLL 与 `JLink.exe`,不查 CMSIS-DAP 注册表。J-Link V9.56 的器件库没有 `STM32H723VGT6`,实测会提示器件名未知并降级到 `STM32H723VG`,自动烧录时弹出器件选择框、把流程卡到 flasher 的 30s 超时;写成 `STM32H723VG` 时整个 launch(烧录+连接+停在 entry)约 2.4s。**已写入用户文档与 README。**

### P7 硬件分级验收(真机到货后,逐级授权)

每级通过才进入下一级;每级都记录 VID/PID、transport、helper PID、owner、VTref、DPIDR、targetState、raw trace 摘要与错误码:

1. **只读连接与身份核对**:连接、DPIDR、DBGMCU_IDCODE(DEV_ID)、Flash 大小寄存器、RAM 抽样读。此级无目标突变,预计可直接授权。**2026-08-25 CMSIS-DAP 真机通过。**
2. **RAM stub**:向 AXI SRAM 写入并读回一段数据;DTCM/D2/D3 各做一次定点读写探针,确认 DAP 可达性。**2026-08-25 CMSIS-DAP 真机通过(AXI/DTCM/D2/D3 均可写回)。**
3. **算法 Init/UnInit**:仅解锁/上锁往返,不擦不写。**2026-08-25 CMSIS-DAP 真机通过。**
4. **授权测试扇区擦写**:擦除最后一个 128 KiB 扇区(应用不占用),program+verify 一页 32 字节倍数数据,再擦除恢复 `0xFF`。**2026-08-25 CMSIS-DAP 真机通过(擦除约 1.11 s)。**
5. **真实 ELF 擦写校验**:用 H723 实际工程 ELF 走完整 `flashBeforeDebug: true` 流程,随后进入调试验证断点/Watch/Timeline/RTT。**2026-08-25 CMSIS-DAP 真机通过(`h7vgt6_test.elf`, owner=`cmsis-dap`,无 J-Link 回退)。**
6. **J-Link 链路冒烟**:同一块板用 J-Link owner 连接、烧录(DLL 侧算法)、调试,确认器件名透传无需代码改动。**2026-09-11 J-Link 真机通过**:owner 只出现 `jlink-native`(helper pid 3844),无 legacy/CMSIS-DAP 回退,无残留进程;DPIDR 0x6BA02477、VTref 3.285V、DBGMCU_IDCODE 0x10016483(DEV_ID 0x483/REV_ID 0x1001)、Flash 容量 1024 KiB、向量表 SP 0x20020000 / Reset 0x0801AFD1;源码断点命中、Watch 求值、native 源级单步、AXI SRAM 回读与断开清理全通过。证据 JSON 在 `outputs/h723-p7/`。
7. **长稳与断线**:采样中拔线/helper crash 的结构化错误与 session 终止行为。**暂缓。**

各级对应的自动化脚本见 P5 层 5(脚本执行仍需逐级授权,授权范围单次有效)。

## 明确不做(1.1.2 边界)

- 不引入 OpenOCD/GDB server/Ozone 自动化路径。
- 不实现 FLM/CMSIS-Pack 解析(登记为 1.3+ 候选,本次注册表设计为其预留 `algorithm` 引用位)。
- 不新增 GD32/F429/G4 器件条目(仅保证注册表形状可扩展)。
- 不改 J-Link 链路的目标访问代码。
- 不因进度跳过任一硬件验收等级,不用 mock 结果宣称真机支持。

## 风险与未决项

| 风险 | 缓解 |
| --- | --- |
| 擦除超时误报(128 KiB 扇区慢) | per-target 超时;P7-4 实测末扇区约 1.11 s,30 s 默认仍保留余量 |
| H7 cache 导致 verify 误判(复刻 F4 历史 bug) | P2 显式设计 cache 失效路径;P7-4/P7-5 Verify 已过 |
| DTCM/D2 经 DAP 写入不确定 | P7-2 已确认 DTCM/D2/D3 可写回 |
| 参数表初稿有误(标"待核实"项) | P7-1 已核实 DPIDR/DEV_ID/Flash 容量 |
| helper 协议变更影响既有 F407 会话 | 新字段可选、缺省保持 F4 常量,双端同步改并回归 cpp-channel mock |
| J-Link 真机未跑 | 已闭环:P7-6 于 2026-09-11 真机通过,owner 只出现 `jlink-native` |
| J-Link 器件库没有 `STM32H723VGT6` | 文档明确 `probe: "jlink"` 的 `device` 必须用 J-Link 器件库名称(`STM32H723VG`);写全称会触发器件选择框并卡到 flasher 30s 超时 |
| 长稳/断线未跑 | P7-7 暂缓,1.1.2 不宣称 |

## 完成定义

- 代码/mock/构建/回归全绿,且 `docs/cmsis-dap-flash-algorithm-references.md`、README、发布物(1.1.2 vsix)更新完毕。
- 硬件验收完成第 1–5 级与第 6 级(J-Link,2026-09-11),第 7 级长稳随后补,证据 JSON 存 `outputs/`,并按仓库规则仅在用户确认后写 `docs/bug-fix-log.md`。
- 报告使用 skill 规定模板,分层陈述"代码通过/mock 通过/真机通过",不越层宣称。
