import * as vscode from 'vscode';
import { DataSamplingManager } from '../../debug-providers/data-sampling-manager';
import { DataSampleSnapshot } from '../../ozone-backend/types';

interface TimelineState {
  autoFollow: boolean;
  timePerDiv: number;
  entries: {
    expression: string;
    enabled: boolean;
    color: string;
    yPerDiv: number;
    yAutoScale: boolean;
    yCenter: number;
  }[];
}

const STATE_KEY = 'ozoneTimelineState';

export class TimelineWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private sampleManager: DataSamplingManager;

  constructor(private context: vscode.ExtensionContext, sampleManager: DataSamplingManager) {
    this.sampleManager = sampleManager;
    this.sampleManager.setOnSamples((snapshots) => this.sendSamples(snapshots));
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.command) {
        case 'init': {
          const saved = this.context.workspaceState.get<TimelineState>(STATE_KEY);
          const entries = this.sampleManager.entriesList.map(e => {
            const s = saved?.entries?.find(se => se.expression === e.expression);
            return {
              expression: e.expression,
              enabled: s?.enabled ?? e.enabled,
              color: s?.color ?? e.color,
              yPerDiv: s?.yPerDiv,
              yAutoScale: s?.yAutoScale,
              yCenter: s?.yCenter,
            };
          });
          this.postMessage({
            command: 'init',
            entries,
            autoFollow: saved?.autoFollow ?? true,
            timePerDiv: saved?.timePerDiv ?? 100,
          });
          const allSnapshots: DataSampleSnapshot[] = [];
          for (const entry of this.sampleManager.entriesList) {
            const pts = this.sampleManager.getAllData(entry.expression);
            if (pts.length > 0) {
              allSnapshots.push({
                expression: entry.expression,
                color: entry.color,
                currentValue: pts[pts.length - 1].display,
                data: pts,
              });
            }
          }
          if (allSnapshots.length > 0) {
            this.postMessage({ command: 'samples', snapshots: allSnapshots });
          }
          break;
        }
        case 'addExpression':
          if (msg.expression) {
            this.sampleManager.addExpression(msg.expression);
            this.sendEntriesRefresh();
          }
          break;
        case 'removeExpression':
          if (msg.expression) {
            this.sampleManager.removeExpression(msg.expression);
            this.sendEntriesRefresh();
          }
          break;
        case 'toggleExpression':
          if (msg.expression !== undefined)
            this.sampleManager.toggleExpression(msg.expression, msg.enabled);
          break;
        case 'clearData':
          this.sampleManager.clearData();
          break;
        case 'saveState':
          if (msg.state) {
            this.context.workspaceState.update(STATE_KEY, msg.state);
          }
          break;
        case 'setColor':
          if (msg.expression && msg.color) {
            this.sampleManager.setColor(msg.expression, msg.color);
            this.sendEntriesRefresh();
          }
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  private sendEntriesRefresh() {
    const saved = this.context.workspaceState.get<TimelineState>(STATE_KEY);
    const entries = this.sampleManager.entriesList.map(e => {
      const s = saved?.entries?.find(se => se.expression === e.expression);
      return {
        expression: e.expression,
        enabled: s?.enabled ?? e.enabled,
        color: s?.color ?? e.color,
        yPerDiv: s?.yPerDiv,
        yAutoScale: s?.yAutoScale,
        yCenter: s?.yCenter,
      };
    });
    this.postMessage({ command: 'entries', entries });
  }

  private sendSamples(snapshots: DataSampleSnapshot[]) {
    this.postMessage({ command: 'samples', snapshots });
  }

  private postMessage(msg: any) {
    try {
      this.view?.webview.postMessage(msg);
    } catch (e) {
      console.error('[Ozone Timeline] postMessage error:', e);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'timeline.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-eval' ${webview.cspSource}; script-src-elem ${webview.cspSource};">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-sideBar-border, #333333);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --error-fg: var(--vscode-errorForeground, #f48771);
      --description-fg: var(--vscode-descriptionForeground, #888888);
    }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family, sans-serif); background: var(--bg); color: var(--fg); font-size: 12px; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #root { height: 100%; display: flex; flex-direction: column; }
  </style>
  <title>Ozone Timeline</title>
</head>
<body>
  <div id="root">Loading...</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
