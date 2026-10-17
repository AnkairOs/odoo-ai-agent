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
- "social_closing": ONLY pure thanks, acknowledgements, greetings that close a chat or goodbyes ("gracias", "ok", "listo", "👍", "chao") with no request, question or new information.
- "question": any request, question, order, complaint or information the business must read.
- "other": anything else.
Return JSON: {"category": ..., "confidence": 0..1, "reply": ...}.
For "social_closing", "reply" is one short friendly sentence in the customer's language, without numbers, prices, dates or promises. Otherwise "reply" is "".
When unsure, use "question".`;

@Injectable()
export class CustomerTriage {
  private readonly logger = new Logger(CustomerTriage.name);

  constructor(private readonly ai: AiService) {}

  async decide(customerText: string): Promise<TriageDecision> {
    if (
      !this.ai.isEnabled() ||
      customerText.trim().length > MAX_TRIAGE_LENGTH
    ) {
      return { kind: 'consult' };
    }
    const result = await this.ai.generateStructured({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: customerText }],
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
