# RTOS Views 调试指南

## 问题分析

根据我的分析，RTOS Views 插件无法检测 RTOS 的原因可能是：

1. **debug-tracker-vscode 扩展没有正确跟踪 ozone 调试器**
   - RTOS Views 插件使用 `debug-tracker-vscode` 扩展来跟踪调试会话
   - `debug-tracker-vscode` 扩展会根据调试器类型（`session.type`）分发事件
   - RTOS Views 插件需要订阅特定的调试器类型才能收到事件

2. **RTOS Views 插件没有正确订阅 ozone 调试器**
   - RTOS Views 插件在激活时读取 `mcu-debug.rtos-views.trackDebuggers` 设置
   - 这个设置需要重新加载窗口才能生效

3. **Ozone 扩展没有正确发送 `stackTrace` 响应**
   - RTOS Views 插件在收到 `FirstStackTrace` 事件时开始检测 RTOS
   - 这个事件由 `debug-tracker-vscode` 扩展在收到 `stackTrace` 响应时发送

## 修复方案

我已经在 Ozone 扩展中添加了以下配置：

```typescript
// Silently ensure ozone is tracked by mcu-debug views on activation
appendWorkspaceArraySetting('memory-view', 'trackDebuggers', 'ozone').catch(() => {});
appendWorkspaceArraySetting('mcu-debug.rtos-views', 'trackDebuggers', 'ozone').catch(() => {});

// Ensure debug-tracker-vscode tracks ozone
appendWorkspaceArraySetting('mcu-debug.debug-tracker-vscode', 'trackDebuggers', 'ozone').catch(() => {});
```

这个修复方案确保：
1. `memory-view.trackDebuggers` 包含 'ozone'
2. `mcu-debug.rtos-views.trackDebuggers` 包含 'ozone'
3. `mcu-debug.debug-tracker-vscode.trackDebuggers` 包含 'ozone'

## 验证步骤

### 1. 重新安装 Ozone 扩展
```bash
cd "C:\Users\22690\Desktop\AI\Ozone for VScode"
npm run build
code --install-extension ozone-for-vscode-0.4.1.vsix
```

### 2. 重新加载 VS Code 窗口
- 按 `Ctrl+Shift+P` 打开命令面板
- 输入 "Reload Window" 并选择 "Developer: Reload Window"

### 3. 打开测试工程
- 打开 `D:\STM32\RoboMaster\26Lao_ShaoBin\Down-cmake` 工程

### 4. 检查设置
确保以下设置正确：
```json
{
  "mcu-debug.rtos-views.trackDebuggers": ["ozone"],
  "mcu-debug.debug-tracker-vscode.trackDebuggers": ["ozone"]
}
```

### 5. 启动调试会话
- 按 `F5` 启动 Ozone 调试会话
- 等待调试会话启动并停止在断点处

### 6. 检查 RTOS Views
- 打开 RTOS Views 面板（XRTOS 标签）
- 检查是否显示 "RTOS detected" 而不是 "No RTOS detected"

### 7. 验证 RTOS 检测
如果 RTOS Views 显示 "RTOS detected"，则修复成功。如果仍然显示 "No RTOS detected"，请检查：

1. 确保 `debug-tracker-vscode` 扩展已安装并激活
   - 按 `Ctrl+Shift+P` 打开命令面板
   - 输入 "Extensions: Show Installed Extensions"
   - 检查 "debug-tracker-vscode" 扩展是否已安装并激活

2. 确保 RTOS Views 插件已安装并激活
   - 按 `Ctrl+Shift+P` 打开命令面板
   - 输入 "Extensions: Show Installed Extensions"
   - 检查 "RTOS Views" 扩展是否已安装并激活

3. 检查 VS Code 输出窗口中的调试信息
   - 按 `Ctrl+Shift+U` 打开输出窗口
   - 选择 "Mcu-debug Tracker" 频道
   - 检查是否有调试信息

## 预期结果

RTOS Views 应该能够检测到 FreeRTOS 并显示任务列表。

## 其他可能的解决方案

如果上述修复方案不起作用，可以尝试以下解决方案：

### 解决方案 1：手动配置 debug-tracker-vscode

1. 打开 VS Code 设置
2. 搜索 "mcu-debug.debug-tracker-vscode.trackDebuggers"
3. 添加 'ozone' 到列表中
4. 重新加载 VS Code 窗口

### 解决方案 2：检查 RTOS Views 插件的订阅

1. 打开 VS Code 输出窗口
2. 选择 "Mcu-debug Tracker" 频道
3. 检查是否有 "rtos-views" 相关的订阅信息

### 解决方案 3：检查 Ozone 扩展的 stackTrace 响应

1. 打开 VS Code 输出窗口
2. 选择 "Ozone" 频道
3. 检查是否有 "stackTrace" 相关的日志

## 联系支持

如果问题仍然存在，请联系 Ozone 扩展支持团队，并提供以下信息：

1. VS Code 版本
2. Ozone 扩展版本
3. RTOS Views 插件版本
4. debug-tracker-vscode 扩展版本
5. 测试工程的配置文件（launch.json 和 settings.json）
6. VS Code 输出窗口中的调试信息
