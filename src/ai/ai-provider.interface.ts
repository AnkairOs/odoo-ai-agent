export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolParameterProperty;
}

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentContext {
  systemPrompt?: string;
  messages: ChatMessage[];
  tenantId: string;
  userId: string;
  metadata?: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentResponse {
  text?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
}

export interface AIProvider {
  readonly name: string;
  generateResponse(
    context: AgentContext,
    tools?: ToolDefinition[],
  ): Promise<AgentResponse>;
}
