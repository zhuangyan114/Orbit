// 验证配置脚本
const vscode = require('vscode');

function verifyConfig() {
    const config = vscode.workspace.getConfiguration('mcu-debug.rtos-views');
    const trackDebuggers = config.get('trackDebuggers', []);
    
    console.log('mcu-debug.rtos-views.trackDebuggers:', trackDebuggers);
    
    if (trackDebuggers.includes('ozone')) {
        console.log('✓ ozone is in trackDebuggers');
    } else {
        console.log('✗ ozone is NOT in trackDebuggers');
        console.log('Please add "ozone" to mcu-debug.rtos-views.trackDebuggers');
    }
    
    const debugTrackerConfig = vscode.workspace.getConfiguration('mcu-debug.debug-tracker-vscode');
    const debugTrackerTrackDebuggers = debugTrackerConfig.get('trackDebuggers', []);
    
    console.log('mcu-debug.debug-tracker-vscode.trackDebuggers:', debugTrackerTrackDebuggers);
    
    if (debugTrackerTrackDebuggers.includes('ozone')) {
        console.log('✓ ozone is in debug-tracker-vscode trackDebuggers');
    } else {
        console.log('✗ ozone is NOT in debug-tracker-vscode trackDebuggers');
        console.log('Please add "ozone" to mcu-debug.debug-tracker-vscode.trackDebuggers');
    }
}

verifyConfig();
