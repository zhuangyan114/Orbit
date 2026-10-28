export function readTimelineTheme() {
  const style = getComputedStyle(document.body);
  const color = (token: string, fallback: string) => style.getPropertyValue(`--vscode-${token}`).trim() || fallback;
  return {
    background: color('editor-background', '#1e1e1e'),
    foreground: color('editor-foreground', '#cccccc'),
    label: color('descriptionForeground', '#999999'),
    grid: color('charts-lines', '#808080'),
    tooltip: color('editorHoverWidget-background', '#252526'),
    tooltipForeground: color('editorHoverWidget-foreground', '#cccccc'),
    cursorA: color('charts-yellow', '#FFD166'),
    cursorB: color('charts-blue', '#79C0FF'),
    highContrast: document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light'),
  };
}
