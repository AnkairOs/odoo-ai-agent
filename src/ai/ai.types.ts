import { tool, type ModelMessage, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { TokenUsage } from './ai-provider.interface.js';

export type AiFailureReason =
  'disabled' | 'timeout' | 'provider_error' | 'invalid_output';

export interface AiFailure {
  ok: false;
  reason: AiFailureReason;
  detail: string;
}

export type AiResult<T> = ({ ok: true } & T) | AiFailure;

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StructuredRequest<T> {
  system: string;
  messages: AiMessage[];
  schema: z.ZodType<T>;
  timeoutMs?: number;
}

export type StructuredResult<T> = AiResult<{ object: T; usage: TokenUsage }>;

export type AiToolSet = ToolSet;

export interface ToolLoopRequest {
  system: string;
  messages: AiMessage[];
  tools: AiToolSet;
  maxSteps?: number;
  timeoutMs?: number;
}

export type ToolLoopResult = AiResult<{
  text: string;
  toolsExecuted: string[];
  usage: TokenUsage;
}>;

export interface ConversationRequest {
  system: string;
  messages: ModelMessage[];
  tools: AiToolSet;
  approvalRequiredTools: string[];
  maxSteps?: number;
  timeoutMs?: number;
}

export interface ConversationApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type ConversationResult = AiResult<{
  text: string;
  messages: ModelMessage[];
  approvals: ConversationApproval[];
  usage: TokenUsage;
}>;

export const defineAiTool = tool;
