# Bug Fix Log

## 逐过程卡死/跳转异常 (2026-07-10)

### 症状
`for(;;) { if(...) { Motor_Disable(); osDelay(10); } ... osDelay(1); }` 中：
1. if 分支末句 `osDelay(10)` 逐过程 → if行有断点时跳回if行，无断点时卡死
2. 各种逐过程后光标跳到 `Motor_Disable` 或 `osDelay(10)`

### 根因
多层问题，逐层排查：

1. **`findNextSourceLineAddress` 返回不可达地址** — if 分支末尾的下一行（else if）被编译器分支跳过，临时断点永不命中 → `waitForHalt` 超时
   - **修复**：替换为 `PC + 指令长度`，并检测下一条指令是否为 SVC/BL/B，跳到其返回地址

2. **SVC/BL 下条指令检测缺失** — `osDelay` 指令未检测为 BL（可能为 SVC 或内联），临时断点设在 SVC/BL 自身上，清理后单步执行导致任务切换
   - **修复**：读取 6 字节，检测 PC+2 处指令类型：16位 SVC/B → 跳 4 字节；32位 BL/BLX/B.W → 跳 6 字节

3. **多步进循环 `line < startLoc` 跳过 BL 检测** — 循环体绕回后 `line < startLoc.line → continue` 在 BL 检测之前执行，导致步进进入函数内部（如 Motor_Disable）
   - **修复**：BL 检测移到 `continue` 之前

4. **DapSession pcStuck 重试** — step-over 返回时 PC 与起始相同（循环绕回合法），但 DapSession 视为"卡住"重试 3 次后失败
   - **修复**：删除 pcStuck 重试逻辑，step-over 成功且 CPU 已停机时直接发送 `stopped` 事件

5. **非分支路径未处理 `line < startLoc`** — temp BP 命中时若映射行号 < 起始行（DWARF 将分支指令映射到前驱行），直接落到多步进导致跳转到 Motor_Disable
   - **修复**：`line < startLoc` 时视为循环绕回完成，直接返回成功

### 涉及文件
- `src/ozone-backend/commander.ts`
- `src/debug/dap-session.ts`

### 验证
- [x] if 分支末句逐过程不卡死、不跳回 if 行
- [x] osDelay(10) 逐过程后光标到绕回后的位置（非 Motor_Disable）
- [x] 底部 osDelay(1) 逐过程后光标到 if 行
- [x] 逐过程不进入 RTOS 调度器代码
