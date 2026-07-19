# RTOS Views 修复验证脚本

Write-Host "=== RTOS Views 修复验证 ===" -ForegroundColor Green

# 检查配置文件
$settingsPath = "D:\STM32\RoboMaster\26Lao_ShaoBin\Down-cmake\.vscode\settings.json"
Write-Host "`n1. 检查配置文件: $settingsPath" -ForegroundColor Yellow

if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath | ConvertFrom-Json
    
    # 检查 mcu-debug.rtos-views.trackDebuggers
    if ($settings.'mcu-debug.rtos-views.trackDebuggers' -contains 'ozone') {
        Write-Host "   ✓ mcu-debug.rtos-views.trackDebuggers 包含 'ozone'" -ForegroundColor Green
    } else {
        Write-Host "   ✗ mcu-debug.rtos-views.trackDebuggers 不包含 'ozone'" -ForegroundColor Red
        Write-Host "   请添加 'ozone' 到配置中" -ForegroundColor Yellow
    }
    
    # 检查 mcu-debug.debug-tracker-vscode.trackDebuggers
    if ($settings.'mcu-debug.debug-tracker-vscode.trackDebuggers' -contains 'ozone') {
        Write-Host "   ✓ mcu-debug.debug-tracker-vscode.trackDebuggers 包含 'ozone'" -ForegroundColor Green
    } else {
        Write-Host "   ✗ mcu-debug.debug-tracker-vscode.trackDebuggers 不包含 'ozone'" -ForegroundColor Red
        Write-Host "   请添加 'ozone' 到配置中" -ForegroundColor Yellow
    }
} else {
    Write-Host "   配置文件不存在" -ForegroundColor Red
}

# 检查扩展是否安装
Write-Host "`n2. 检查扩展是否安装" -ForegroundColor Yellow

$extensions = @(
    "mcu-debug.rtos-views",
    "mcu-debug.debug-tracker-vscode",
    "orbit-debug.orbit-for-vscode"
)

foreach ($ext in $extensions) {
    $extPath = Join-Path $env:USERPROFILE ".vscode\extensions" "*$ext*"
    if (Test-Path $extPath) {
        Write-Host "   ✓ $ext 已安装" -ForegroundColor Green
    } else {
        Write-Host "   ✗ $ext 未安装" -ForegroundColor Red
    }
}

# 提示用户重新加载窗口
Write-Host "`n3. 请重新加载 VS Code 窗口" -ForegroundColor Yellow
Write-Host "   按 Ctrl+Shift+P 打开命令面板" -ForegroundColor White
Write-Host "   输入 'Reload Window' 并选择 'Developer: Reload Window'" -ForegroundColor White

# 提示用户启动调试会话
Write-Host "`n4. 启动调试会话" -ForegroundColor Yellow
Write-Host "   打开测试工程 D:\STM32\RoboMaster\26Lao_ShaoBin\Down-cmake" -ForegroundColor White
Write-Host "   按 F5 启动 Orbit 调试会话" -ForegroundColor White

# 提示用户检查 RTOS Views
Write-Host "`n5. 检查 RTOS Views" -ForegroundColor Yellow
Write-Host "   打开 RTOS Views 面板（XRTOS 标签）" -ForegroundColor White
Write-Host "   检查是否显示 'RTOS detected' 而不是 'No RTOS detected'" -ForegroundColor White

Write-Host "`n=== 验证完成 ===" -ForegroundColor Green
