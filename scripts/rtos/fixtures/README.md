# 阶段 0：FreeRTOS 离线 fixtures

本目录提供可重建的 Cortex-M ELF 和独立 SystemView 字节样本，不实现 Orbit 快照/Trace 引擎。所有脚本均离线运行：没有探针发现、网络访问、烧录、目标控制或目标内存写入。

## 构建与检查

在 Orbit 根目录执行，输出默认写到被 Git 忽略的 out/rtos-stage0/fixtures：

```powershell
python scripts/rtos/fixtures/build.py
python -m unittest discover -s scripts/rtos/fixtures -p test_fixtures.py -v
```

已验证环境为 Windows x64、Python 3.10+、CMake 4.4.0、Arm GNU GCC 13.3.Rel1、MinGW GCC 8.1.0。PATH 需要 cmake、mingw32-make、gcc、arm-none-eabi-gcc/nm/objdump/objcopy。构建不下载依赖，不读取外部 STM32 工程或本机 Cube 包。其他工具链/系统尚未验收。

每次构建先检查 vendor-manifest.json 的文件集合、长度和 SHA256，然后构建、核对 ELF 中真实配置、内核符号、DWARF 和不同配置的尺寸差异；最后重新运行官方记录器并逐字节比较已提交样本。verification.json 保存输出 hash、编译器、配置和未实板执行状态；symbols.txt/dwarf.txt 与编译日志留在输出目录。

只有明确更新样本时使用以下命令；同时审查原始字节、元数据与人工 oracle 的差异，不能用更新样本掩盖校验失败：

```powershell
python scripts/rtos/fixtures/build.py --update-samples
python scripts/rtos/fixtures/build.py --samples-only
```

可以用 --output 指定另一个空输出目录验证重建。所有源码与依赖均在本目录；构建禁止将输出写回此源码目录。工程和构建路径采用 prefix-map；隔离目录重建的 11 个可加载镜像及 5 份样本字节一致，但 Debug ELF hash 仍有差异，证据分别登记，不承诺整个 ELF 的逐字节重现。

## ELF 矩阵

| 变体 | 配置/用途 |
|---|---|
| native-debug | -Og、DWARF4、原生任务，动态与静态分配并存 |
| cmsis-v1 | 同一内核的 CMSIS-RTOS v1 任务入口 |
| cmsis-v2 | CMSIS-RTOS v2；按包装层要求使用 56 个优先级，其他变体为 8 |
| native-optimized | -O2，保留 DWARF |
| native-no-stats | 关闭运行统计，StaticTask_t 相对基线减少一个 32 位字段 |
| native-no-stack-bound | 不记录栈高地址，StaticTask_t 相对基线减少一个指针字段 |
| native-tickless | 开启 tickless |
| native-no-dwarf | 从 native-debug 去除调试信息，普通内核符号仍保留 |
| trace-continuous / trace-single-shot / trace-post-mortem | 三种标准记录配置，使用较小任务集 |

内核来自 STM32CubeH7 1.12.1 的 FreeRTOS 10.3.1，port 为 GCC/ARM_CM4F，allocator 为 heap_4。沿用既有 H723 工程的 port 选择，不代表 CPUID 和运行行为已验证。固件保留默认 HSI，经 SystemCoreClockUpdate 获取时钟；不初始化原应用的 PLL、HAL 外设、通信或执行器。D-cache 保持关闭；后续开启 cache 需要独立处理 RAM/RTT 一致性。

启动文件和链接脚本保留原始字节。CMake 在输出目录生成链接脚本副本，只移除原脚本丢弃 libc/libm/libgcc 的条款，供新工具链正常链接 C 运行时；不修改内存区域。运行统计为 DWT 32 位周期计数，单位 cycles，休眠期间的计数行为和回绕须后续实板核对，不能直接当作含休眠的墙钟 CPU%。

## 固件场景与独立对照

- native/CMSIS 初始为十个 worker、coordinator，加内核 IDLE 和 timer task；这是源码定义的预期，不是实测任务数。Trace 为两个 worker，遵守固定适配器 8 项任务信息上限。
- coordinator 先持有普通 mutex 与两次递归 mutex；worker02 等待 mutex，worker03 等待 queue。binary/counting semaphore、queue registry 和 software timer 可供对象发现测试。
- fixtureState.phase=1 为初始对照；随后 suspend worker00、delete worker01，phase=2 保留待回收/挂起场景；延时后创建 recreated、恢复 worker00，phase=3。TCB 是否复用由实读确认。
- fixtureTaskOracle/fixtureState.oracleCount、oracleTotal 来自目标端 uxTaskGetSystemState，供阶段 1 与探针读出的结果对照；当前未运行，不能当成已有快照数据。
- EXTI0/EXTI1 通过 NVIC 软件置 pending，后者优先级更高；fixtureState.nestedIsrCalls 记录是否在外层处理期间进入。未配置实际 GPIO 输入。
- worker 使用 96-byte volatile 局部数组形成可查的栈访问；水位仍以填充值和可靠栈边界判断，不以该数组大小直接充当峰值。
- ambiguity-a/b 的两个编译单元分别定义同名 OrbitSameName，布局不同；全局根各自唯一，供类型身份解析测试。

fixtureCapture 导出模式、冻结代次、buffer/size/rdOff/wrOff 和停止前状态。Single-Shot 在场景结束显式 Stop 后发布 frozen；Post-Mortem 先生成覆盖负载，再 Stop 冻结；Continuous 持续运行，响应标准 Down Stop，之后发布冻结状态。冻结在 PRIMASK 临界区内发布，避免在途 ISR 继续写入。此元数据只属于 fixture，不假定其他固件也有。

## 独立事件样本

host/recorder.c 直接链接原样 SystemView 3.32 和 RTT C 实现，使用确定的 1 MHz 主机模拟 timestamp，不包含 Orbit 生产编码器/解码器。samples 的 .bin 是 RTT 原始流，不是 SVDat 容器。配套 JSON 保存模式、冻结状态、偏移、完整性、hash 和 hardware=not-run。

| 样本 | 验证内容 |
|---|---|
| continuous / single-shot | 同一确定序列：任务创建→Ready→Running、嵌套 ISR、Marker 300、任务删除；host/oracle.json 手算十个包的字节，逐包比较 |
| continuous-overflow | 暂停主机消费使记录器进入丢包状态；恢复消费后验证 OVERFLOW，完整性仍标 target-overflow |
| single-shot-overflow | 不在冻结前消费，确认满缓冲进入状态 2，Stop 后冻结；不能标为完整录制 |
| post-mortem | 连续覆盖后保留 8191 bytes，包含周期 sync；记录实际产生字节与保留字节的差，不估算丢失事件数 |

主机模拟不是真实中断调度或 FreeRTOS 运行。64 位主机只证明字节流及 RTT 环形逻辑；目标固件另用 static_assert 检查 32 位指针和 24-byte RTT descriptor ABI。主机编译时官方未调用的 pointer/heap API 有 64→32 位转换警告；样本使用显式 32 位资源 ID，不传入主机地址。

3.32 固定非零通道的 Post-Mortem 初始化分支没有设置 context.UpChannel，导致同步写指定通道、事件写默认通道。fixture 使用该版本官方自动分配路径，预先保留通道 1，使 SysView 实际分配到 2；脚本确认名称，第三方源码不打补丁。后续发现通道仍按名称和 descriptor，不硬编码 2。

## 来源、许可与未验证项

vendor-manifest.json 记录 63 个原始文件的来源标识和 hash；不臆造本地快照的上游 commit。vendor 属性禁止换行转换，保留原始版权、许可和上游空白，不对第三方源码做格式化。FreeRTOS、CMSIS、ST device 和 RTT 的许可文件随源保存；SystemView/Global.h 保留逐文件再分发条款，不纳入桌面 SystemView 二进制。

未纳入已废弃且未使用的 StackMacros.h 兼容头，避免与实际使用的 stack_macros.h 在默认 Windows 文件系统上冲突；脚本拒绝仅大小写不同的依赖路径。CMSIS v2 的应用和包装实现统一使用包装层自带的 cmsis_os2.h，避免被另一份 CMSIS API 头遮蔽。

此处构建与样本均为离线证据。真实 CPU/板卡 ID、port 适用性、HSI/DWT、IRQ 嵌套、任务状态、栈水位、Wi-Fi 吞吐、控制响应和三种模式实板采集均未验收，按总计划 1.4/3.4/4.4 补齐。其他 RTOS、快照引擎、Trace 解码器、面板、自动化 API 与 SVDat 互操作不属于本阶段。
