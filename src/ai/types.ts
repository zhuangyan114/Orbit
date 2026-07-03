import { DebugContext, AIResult } from '../ozone-backend/types';

export type AIProviderType = 'ollama' | 'openai-compatible';

export interface AIProviderConfig {
  type: AIProviderType;
  url: string;
  model: string;
  apiKey?: string;
}

export interface AIProvider {
  readonly type: AIProviderType;
  readonly name: string;
  analyze(context: DebugContext, prompt: string): Promise<AIResult>;
  chat(messages: ChatMessage[]): Promise<AIResult>;
  dispose(): void;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}