import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service.js';

export type TriageDecision =
  { kind: 'auto_reply'; reply: string } | { kind: 'consult' };

export const SAFE_CLOSING_REPLY = '¡A la orden! 😊';

const MIN_CONFIDENCE = 0.8;
const MAX_REPLY_LENGTH = 80;
const MAX_TRIAGE_LENGTH = 40;

const TriageSchema = z.object({
  category: z.enum(['social_closing', 'question', 'other']),
  confidence: z.number().min(0).max(1),
  reply: z.string(),
});

const SYSTEM_PROMPT = `You triage WhatsApp messages that customers send to a small business.
Classify the customer's latest message:
- "social_closing": ONLY explicit, standalone goodbyes or pure thanks after a completed interaction ("muchas gracias", "hasta luego", "chao", "que tenga buen día").
CRITICAL RULE: NEVER classify affirmations, acceptances, purchase intent, or short answers ("sí", "si", "claro", "me sirve", "dale", "de acuerdo", "quiero", "ok envíeme", "listo pásame la cuenta") as social_closing; these are critical commercial answers and MUST be classified as "question" so the business operator can close the sale.
- "question": any request, question, purchase interest, confirmation, acceptance of an offer ("sí", "me sirve"), complaint or information the business operator must read.
- "other": anything else.
When in doubt, always classify as "question".
Return JSON: {"category": ..., "confidence": 0..1, "reply": ...}.
For "social_closing", "reply" is one short friendly sentence in the customer's language, without numbers, prices, dates or promises. Otherwise "reply" is "".`;

@Injectable()
export class CustomerTriage {
  private readonly logger = new Logger(CustomerTriage.name);

  constructor(private readonly ai: AiService) {}

  async decide(
    customerText: string,
    priorContext?: string,
  ): Promise<TriageDecision> {
    if (
      !this.ai.isEnabled() ||
      customerText.trim().length > MAX_TRIAGE_LENGTH
    ) {
      return { kind: 'consult' };
    }
    const contextPrompt = priorContext?.trim()
      ? `Prior conversation context (last message sent by the business to the customer):\n"${priorContext.trim()}"\n\nCustomer's latest incoming message:\n"${customerText.trim()}"`
      : customerText;
    const result = await this.ai.generateStructured({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contextPrompt }],
      schema: TriageSchema,
    });
    if (!result.ok) {
      this.logger.warn(
        `Triage unavailable (${result.reason}): ${result.detail}`,
      );
      return { kind: 'consult' };
    }
    const { category, confidence, reply } = result.object;
    if (category !== 'social_closing' || confidence < MIN_CONFIDENCE) {
      return { kind: 'consult' };
    }
    return { kind: 'auto_reply', reply: safeClosingReply(reply) };
  }
}

function safeClosingReply(reply: string): string {
  const text = reply.trim();
  const unsafe =
    text.length === 0 ||
    text.length > MAX_REPLY_LENGTH ||
    /[\r\n]/.test(text) ||
    /\d/.test(text) ||
    /[$€£¥]/.test(text);
  return unsafe ? SAFE_CLOSING_REPLY : text;
}
