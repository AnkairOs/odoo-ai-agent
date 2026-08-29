import { IncomingMessage } from '../channels/channel.interface.js';
import { Tenant, TenantUser } from '../tenants/tenant.interface.js';
import { TokenUsage } from '../ai/ai-provider.interface.js';

export interface ActionConfirmationRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
  expiresAt: Date;
}

export interface ConversationTurnResult {
  replyText: string;
  executedTools: string[];
  pendingConfirmation?: ActionConfirmationRequest;
  usage?: TokenUsage;
}

export interface AgentOrchestrator {
  processIncomingMessage(
    message: IncomingMessage,
    tenantContext: { tenant: Tenant; user: TenantUser },
  ): Promise<ConversationTurnResult>;
}
