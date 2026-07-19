import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { DapSession, DebugProtocolMessage } from './dap-session';

export class OzoneDebugAdapter implements vscode.DebugAdapter {
  private _onDidSendMessage = new vscode.EventEmitter<DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;
  private session: DapSession;

  constructor(private backend: OzoneBackend) {
    this.session = new DapSession(backend);
    this.session.on('send', (msg: DebugProtocolMessage) => {
      this._onDidSendMessage.fire(msg);
    });
  }

  handleMessage(message: DebugProtocolMessage): void {
    this.session.handleMessage(message);
  }

  dispose() {
    void this.session.dispose();
  }
}
