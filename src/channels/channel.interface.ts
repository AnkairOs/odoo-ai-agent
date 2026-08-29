export type SupportedChannel = 'whatsapp' | 'telegram' | 'web';

export interface IncomingMessage {
  id: string;
  channel: SupportedChannel;
  senderId: string;
  recipientId?: string;
  conversationId: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  recipientId: string;
  conversationId: string;
  text: string;
  channel: SupportedChannel;
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channel: SupportedChannel;
  parseWebhookPayload(payload: unknown): IncomingMessage | null;
  sendMessage(message: OutgoingMessage): Promise<boolean>;
}
