import { AIProvider, AIProviderConfig, ChatMessage } from '../types';
import { DebugContext, AIResult } from '../../ozone-backend/types';

export class OpenAICompatibleProvider implements AIProvider {
  readonly type = 'openai-compatible';
  readonly name = 'OpenAI Compatible';

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
      const response = await fetch(`${this.config.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
        }),
      });

      if (!response.ok) {
        return { text: `API error: ${response.status} ${response.statusText}` };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      return { text: content };
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

Provide concise, actionable advice for debugging embedded ARM Cortex-M firmware.`;
  }

  dispose() {}
}