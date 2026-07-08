// 调试 tracker 测试脚本
const vscode = require('vscode');

function debugTracker() {
    console.log('=== Debug Tracker 测试 ===');
    
    // 检查调试会话
    const session = vscode.debug.activeDebugSession;
    if (session) {
        console.log('当前调试会话:', session.name);
        console.log('会话类型:', session.type);
        console.log('会话ID:', session.id);
    } else {
        console.log('没有活动的调试会话');
    }
    
    // 检查配置
    const config = vscode.workspace.getConfiguration('mcu-debug.rtos-views');
    const trackDebuggers = config.get('trackDebuggers', []);
    console.log('mcu-debug.rtos-views.trackDebuggers:', trackDebuggers);
    
    const debugTrackerConfig = vscode.workspace.getConfiguration('mcu-debug.debug-tracker-vscode');
    const debugTrackerTrackDebuggers = debugTrackerConfig.get('trackDebuggers', []);
    console.log('mcu-debug.debug-tracker-vscode.trackDebuggers:', debugTrackerTrackDebuggers);
    
    console.log('=== 测试完成 ===');
}

debugTracker();
