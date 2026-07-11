// 验证配置脚本
const fs = require('fs');
const path = require('path');

const settingsPath = 'D:\\STM32\\RoboMaster\\26Lao_ShaoBin\\Down-cmake\\.vscode\\settings.json';

console.log('=== RTOS Views 配置验证 ===\n');

if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    
    // 检查 mcu-debug.rtos-views.trackDebuggers
    if (settings['mcu-debug.rtos-views.trackDebuggers'] && 
        settings['mcu-debug.rtos-views.trackDebuggers'].includes('ozone')) {
        console.log('✓ mcu-debug.rtos-views.trackDebuggers 包含 "ozone"');
    } else {
        console.log('✗ mcu-debug.rtos-views.trackDebuggers 不包含 "ozone"');
        console.log('  请添加 "ozone" 到配置中');
    }
    
    // 检查 mcu-debug.debug-tracker-vscode.trackDebuggers
    if (settings['mcu-debug.debug-tracker-vscode.trackDebuggers'] && 
        settings['mcu-debug.debug-tracker-vscode.trackDebuggers'].includes('ozone')) {
        console.log('✓ mcu-debug.debug-tracker-vscode.trackDebuggers 包含 "ozone"');
    } else {
        console.log('✗ mcu-debug.debug-tracker-vscode.trackDebuggers 不包含 "ozone"');
        console.log('  请添加 "ozone" 到配置中');
    }
} else {
    console.log('配置文件不存在:', settingsPath);
}

console.log('\n=== 验证完成 ===');
