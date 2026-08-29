import { ToolParameterSchema, AgentContext } from '../ai/ai-provider.interface.js';

export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requiresConfirmation?: boolean;
  confirmationDetails?: {
    action: string;
    summary: string;
    payload: Record<string, unknown>;
  };
}

export interface BusinessTool<TArgs = Record<string, unknown>, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  readonly isMutating: boolean;
  execute(args: TArgs, context: AgentContext): Promise<ToolExecutionResult<TResult>>;
}
