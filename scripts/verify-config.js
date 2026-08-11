// 验证配置脚本
const vscode = require('vscode');

function verifyConfig() {
    const config = vscode.workspace.getConfiguration('mcu-debug.rtos-views');
    const trackDebuggers = config.get('trackDebuggers', []);
    
    console.log('mcu-debug.rtos-views.trackDebuggers:', trackDebuggers);
    
    if (trackDebuggers.includes('orbit') || trackDebuggers.includes('ozone')) {
        console.log('✓ orbit or ozone is in trackDebuggers');
    } else {
        console.log('✗ orbit and ozone are NOT in trackDebuggers');
        console.log('Please add "orbit" (or the legacy alias "ozone") to mcu-debug.rtos-views.trackDebuggers');
    }
    
    const debugTrackerConfig = vscode.workspace.getConfiguration('mcu-debug.debug-tracker-vscode');
    const debugTrackerTrackDebuggers = debugTrackerConfig.get('trackDebuggers', []);
    
    console.log('mcu-debug.debug-tracker-vscode.trackDebuggers:', debugTrackerTrackDebuggers);
    
    if (debugTrackerTrackDebuggers.includes('orbit') || debugTrackerTrackDebuggers.includes('ozone')) {
        console.log('✓ orbit or ozone is in debug-tracker-vscode trackDebuggers');
    } else {
        console.log('✗ orbit and ozone are NOT in debug-tracker-vscode trackDebuggers');
        console.log('Please add "orbit" (or the legacy alias "ozone") to mcu-debug.debug-tracker-vscode.trackDebuggers');
    }
}

verifyConfig();
