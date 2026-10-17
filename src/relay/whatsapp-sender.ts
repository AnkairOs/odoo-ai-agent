import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OutgoingText {
  to: string;
  body: string;
  contextMessageId?: string;
}

export type SendResult =
  | { kind: 'sent'; messageId: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unknown'; reason: string };

export interface WhatsAppSender {
  sendText(message: OutgoingText): Promise<SendResult>;
}

export const WHATSAPP_SENDER = Symbol('WHATSAPP_SENDER');

const DEFAULT_BASE_URL = 'https://api.kapso.ai/meta/whatsapp';
const DEFAULT_GRAPH_VERSION = 'v23.0';
const REQUEST_TIMEOUT_MS = 8000;

@Injectable()
export class KapsoSender implements WhatsAppSender {
  constructor(private readonly configService: ConfigService) {}

  async sendText(message: OutgoingText): Promise<SendResult> {
    const apiKey = this.configService.get<string>('KAPSO_API_KEY');
    const phoneNumberId = this.configService.get<string>(
      'KAPSO_PHONE_NUMBER_ID',
    );
    if (!apiKey || !phoneNumberId) {
      return { kind: 'rejected', reason: 'Kapso no está configurado' };
    }

    let response: Response;
    try {
      response = await fetch(this.messagesUrl(phoneNumberId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(toTextPayload(message)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        kind: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.status >= 400 && response.status < 500) {
      return { kind: 'rejected', reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { kind: 'unknown', reason: `HTTP ${response.status}` };
    }
    const messageId = extractMessageId(
      await response.json().catch(() => undefined),
    );
    return messageId
      ? { kind: 'sent', messageId }
      : { kind: 'unknown', reason: 'respuesta sin id de mensaje' };
  }

  private messagesUrl(phoneNumberId: string): string {
    const baseUrl =
      this.configService.get<string>('KAPSO_API_BASE_URL') || DEFAULT_BASE_URL;
    const graphVersion =
      this.configService.get<string>('KAPSO_GRAPH_VERSION') ||
      DEFAULT_GRAPH_VERSION;
    return `${baseUrl.replace(/\/+$/, '')}/${graphVersion}/${phoneNumberId}/messages`;
  }
}

function toTextPayload(message: OutgoingText): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
    type: 'text',
    text: { body: message.body, preview_url: false },
    ...(message.contextMessageId
      ? { context: { message_id: message.contextMessageId } }
      : {}),
  };
}

function extractMessageId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const first: unknown = messages[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
