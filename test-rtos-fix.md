# RTOS Views 修复验证步骤

## 问题描述
XRTOS 插件无法正常使用，显示 "No RTOS detected" 和 "RTOS detection may be still in progress"

## 根本原因
1. RTOS Views 插件使用 `debug-tracker-vscode` 扩展来跟踪调试会话
2. `debug-tracker-vscode` 扩展会根据调试器类型（`session.type`）分发事件
3. RTOS Views 插件需要订阅特定的调试器类型才能收到事件
4. 虽然用户配置了 `mcu-debug.rtos-views.trackDebuggers: ["ozone"]`，但 RTOS Views 插件在激活时读取配置并订阅，此时可能配置还未生效

## 修复方案
在 Ozone 扩展的 activate 函数中添加 `mcu-debug.debug-tracker-vscode.trackDebuggers` 设置，确保 debug-tracker-vscode 扩展跟踪 ozone 调试器。

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
2. 确保 RTOS Views 插件已安装并激活
3. 检查 VS Code 输出窗口中的调试信息

## 预期结果
RTOS Views 应该能够检测到 FreeRTOS 并显示任务列表。
