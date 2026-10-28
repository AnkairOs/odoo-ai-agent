export interface InboundMessage {
  id: string;
  phoneNumberId: string;
  from: string;
  contactName?: string;
  type: string;
  text?: string;
  quotedMessageId?: string;
}

export function parseReceivedMessages(body: unknown): InboundMessage[] {
  if (!isRecord(body)) {
    return [];
  }
  const payloads =
    body.batch === true && Array.isArray(body.data) ? body.data : [body];
  return payloads
    .map(parseReceivedMessage)
    .filter((m): m is InboundMessage => m !== undefined);
}

function parseReceivedMessage(payload: unknown): InboundMessage | undefined {
  if (!isRecord(payload) || !isRecord(payload.message)) {
    return undefined;
  }
  const { message } = payload;
  const conversation = isRecord(payload.conversation)
    ? payload.conversation
    : {};
  const id = asString(message.id);
  const phoneNumberId =
    asString(payload.phone_number_id) ?? asString(conversation.phone_number_id);
  const from = asString(message.from);
  if (!id || !phoneNumberId || !from) {
    return undefined;
  }
  return {
    id,
    phoneNumberId,
    from,
    contactName: asString(conversation.contact_name),
    type: asString(message.type) ?? 'unknown',
    text: resolveMessageText(message),
    quotedMessageId: isRecord(message.context)
      ? asString(message.context.id)
      : undefined,
  };
}

export function isInboundMessage(value: unknown): value is InboundMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.phoneNumberId === 'string' &&
    typeof value.from === 'string' &&
    typeof value.type === 'string' &&
    isOptionalString(value.contactName) &&
    isOptionalString(value.text) &&
    isOptionalString(value.quotedMessageId)
  );
}

function resolveMessageText(
  message: Record<string, unknown>,
): string | undefined {
  if (isRecord(message.text)) {
    const textBody = asString(message.text.body);
    if (textBody) {
      return textBody;
    }
  }

  const kapso = isRecord(message.kapso) ? message.kapso : undefined;
  if (kapso) {
    if (isRecord(kapso.transcript)) {
      const transcriptText = asString(kapso.transcript.text);
      if (transcriptText) {
        return `[Audio]: ${transcriptText}`;
      }
    }
    const content = asString(kapso.content);
    if (content) {
      const match = content.match(/Transcript:\s*([\s\S]+)$/i);
      if (match && match[1]?.trim()) {
        return `[Audio]: ${match[1].trim()}`;
      }
    }
  }

  for (const mediaKey of ['image', 'video', 'document'] as const) {
    const mediaObj = message[mediaKey];
    if (isRecord(mediaObj)) {
      const caption = asString(mediaObj.caption);
      if (caption) {
        return caption;
      }
    }
  }

  return undefined;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
