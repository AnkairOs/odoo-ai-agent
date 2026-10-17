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
    text: isRecord(message.text) ? asString(message.text.body) : undefined,
    quotedMessageId: isRecord(message.context)
      ? asString(message.context.id)
      : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
