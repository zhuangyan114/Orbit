import * as vscode from 'vscode';
import { AIProvider, AIProviderConfig, AIProviderType, ChatMessage } from './types';
import { OllamaProvider } from './providers/ollama-provider';
import { OpenAICompatibleProvider } from './providers/openai-compatible-provider';
import { DebugContext, AIResult } from '../ozone-backend/types';

export class AIProviderManager {
  private provider: AIProvider | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.initProvider();
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ozone.ai')) {
        this.initProvider();
      }
    });
  }

  private initProvider() {
    const cfg = vscode.workspace.getConfiguration('ozone.ai');
    if (!cfg.get<boolean>('enabled', true)) {
      this.provider = null;
      return;
    }

    const type = cfg.get<AIProviderType>('provider', 'ollama');
    const config: AIProviderConfig = {
      type,
      url: cfg.get<string>(`${type}Url`, type === 'ollama' ? 'http://localhost:11434' : ''),
      model: cfg.get<string>(`${type}Model`, type === 'ollama' ? 'llama3.2' : 'gpt-4o-mini'),
      apiKey: cfg.get<string>('openaiKey', ''),
    };

    this.provider = type === 'ollama'
      ? new OllamaProvider(config)
      : new OpenAICompatibleProvider(config);
  }

  async analyze(context: DebugContext, prompt: string): Promise<AIResult> {
    if (!this.provider) {
      return { text: 'AI is disabled. Enable via settings (ozone.ai.enabled).' };
    }
    return this.provider.analyze(context, prompt);
  }

  async chat(messages: ChatMessage[]): Promise<AIResult> {
    if (!this.provider) {
      return { text: 'AI is disabled.' };
    }
    return this.provider.chat(messages);
  }

  get currentProvider(): AIProvider | null {
    return this.provider;
  }

  dispose() {
    this.provider?.dispose();
  }
}