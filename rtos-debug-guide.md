# RTOS Views 调试指南

## 问题分析

根据我对 RTOS Views 插件源代码的分析，问题的根本原因是：

### RTOS Views 插件的工作原理

1. **订阅机制**：RTOS Views 插件使用 `debug-tracker-vscode` 扩展来跟踪调试会话
2. **订阅时机**：RTOS Views 插件在激活时调用 `subscribeToTracker()` 方法订阅调试器事件
3. **调试器列表**：订阅时使用的是硬编码的 `TrackedDebuggers` 数组

### 问题所在

1. `TrackedDebuggers` 数组是硬编码的，不包括 'ozone'
2. `updateTrackedDebuggersFromSettings(false)` 会将 'ozone' 添加到 `TrackedDebuggers` 数组
3. 但是 `subscribe()` 已经调用了，不会重新订阅
4. 即使配置改变，RTOS Views 插件也不会重新订阅

### 解决方案

1. 确保配置正确
2. 重新加载 VS Code 窗口

## 验证步骤

### 步骤 1：检查配置文件

确保 `D:\STM32\RoboMaster\26Lao_ShaoBin\Down-cmake\.vscode\settings.json` 包含以下内容：

```json
{
    "ozone.defaultProgram": "d:\\STM32\\RoboMaster\\26Lao_ShaoBin\\Down-cmake\\build\\Debug\\frame.elf",
    "memory-view.trackDebuggers": [
        "ozone"
    ],
    "mcu-debug.rtos-views.trackDebuggers": [
        "ozone"
    ],
    "mcu-debug.debug-tracker-vscode.trackDebuggers": [
        "ozone"
    ]
}
```

### 步骤 2：重新加载 VS Code 窗口

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Reload Window" 并选择 "Developer: Reload Window"
3. 等待窗口重新加载完成

### 步骤 3：验证配置是否生效

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Preferences: Open Workspace Settings (JSON)"
3. 检查配置文件是否包含以下内容：

```json
{
    "mcu-debug.rtos-views.trackDebuggers": ["ozone"],
    "mcu-debug.debug-tracker-vscode.trackDebuggers": ["ozone"]
}
```

### 步骤 4：启动调试会话

1. 打开测试工程 `D:\STM32\RoboMaster\26Lao_ShaoBin\Down-cmake`
2. 按 `F5` 启动 Ozone 调试会话
3. 等待调试会话启动并停止在断点处

### 步骤 5：检查 RTOS Views

1. 打开 RTOS Views 面板（XRTOS 标签）
2. 检查是否显示 "RTOS detected" 而不是 "No RTOS detected"

### 步骤 6：验证 RTOS 检测

如果 RTOS Views 显示 "RTOS detected"，则修复成功。如果仍然显示 "No RTOS detected"，请继续下面的步骤。

## 高级调试

### 检查 debug-tracker-vscode 扩展

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Extensions: Show Installed Extensions"
3. 检查 "debug-tracker-vscode" 扩展是否已安装并激活

### 检查 RTOS Views 插件

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Extensions: Show Installed Extensions"
3. 检查 "RTOS Views" 扩展是否已安装并激活

### 检查 VS Code 输出窗口

1. 按 `Ctrl+Shift+U` 打开输出窗口
2. 选择 "Mcu-debug Tracker" 频道
3. 检查是否有调试信息

### 手动配置 debug-tracker-vscode

如果上述步骤不起作用，可以尝试手动配置 debug-tracker-vscode：

1. 打开 VS Code 设置
2. 搜索 "mcu-debug.debug-tracker-vscode.trackDebuggers"
3. 添加 'ozone' 到列表中
4. 重新加载 VS Code 窗口

## 预期结果

RTOS Views 应该能够检测到 FreeRTOS 并显示任务列表。

## 联系支持

如果问题仍然存在，请联系 Ozone 扩展支持团队，并提供以下信息：

1. VS Code 版本
2. Ozone 扩展版本
3. RTOS Views 插件版本
4. debug-tracker-vscode 扩展版本
5. 测试工程的配置文件（launch.json 和 settings.json）
6. VS Code 输出窗口中的调试信息
