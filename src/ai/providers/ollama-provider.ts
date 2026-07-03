import { AIProvider, AIProviderConfig, ChatMessage } from '../types';
import { DebugContext, AIResult } from '../../ozone-backend/types';

export class OllamaProvider implements AIProvider {
  readonly type = 'ollama';
  readonly name = 'Ollama';

  constructor(private config: AIProviderConfig) {}

  async analyze(context: DebugContext, prompt: string): Promise<AIResult> {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];
    return this.chat(messages);
  }

  async chat(messages: ChatMessage[]): Promise<AIResult> {
    try {
      const response = await fetch(`${this.config.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
        }),
      });

      if (!response.ok) {
        return { text: `Ollama error: ${response.status} ${response.statusText}` };
      }

      const data = await response.json();
      return { text: data.message?.content ?? '' };
    } catch (err: any) {
      return { text: `Connection failed: ${err.message}` };
    }
  }

  private buildSystemPrompt(context: DebugContext): string {
    return `You are an embedded systems debugging assistant.
Current state:
- PC: 0x${context.pc?.toString(16) ?? '??'}
- Registers: ${context.registers?.map(r => `${r.name}=${r.hex}`).join(', ') ?? 'N/A'}
- Call stack: ${context.callStack?.map(s => s.function).join(' → ') ?? 'N/A'}
- Source: ${context.sourceFile ?? 'N/A'}:${context.sourceLine ?? 'N/A'}

Provide concise, actionable advice for debugging embedded ARM Cortex-M firmware.`;
  }

  dispose() {}
}