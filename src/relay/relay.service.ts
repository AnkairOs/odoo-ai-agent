import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboundMessage } from './kapso-payload.js';
import { RelayMessages } from './relay.messages.js';
import { Consultation, RelayStore } from './relay.store.js';
import { WHATSAPP_SENDER } from './whatsapp-sender.js';
import type { WhatsAppSender } from './whatsapp-sender.js';

@Injectable()
export class RelayService {
  private readonly logger = new Logger(RelayService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly store: RelayStore,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsAppSender,
  ) {}

  async handle(messages: InboundMessage[]): Promise<void> {
    const businessPhoneId = this.configService.get<string>(
      'KAPSO_PHONE_NUMBER_ID',
    );
    const operatorWaId = this.configService.get<string>('RELAY_OPERATOR_WA_ID');
    if (!businessPhoneId || !operatorWaId) {
      this.logger.error(
        'Relay is not configured (KAPSO_PHONE_NUMBER_ID / RELAY_OPERATOR_WA_ID); message ignored',
      );
      return;
    }
    const fresh = messages.filter((message) =>
      this.accept(message, businessPhoneId),
    );
    for (const unit of groupCustomerBursts(fresh, operatorWaId)) {
      if (unit.kind === 'operator') {
        await this.handleOperatorReply(unit.message, operatorWaId);
      } else {
        await this.handleCustomerMessages(unit.messages, operatorWaId);
      }
    }
  }

  private accept(message: InboundMessage, businessPhoneId: string): boolean {
    if (message.phoneNumberId !== businessPhoneId) {
      this.logger.warn(
        `Ignoring message for unexpected phone number id ${message.phoneNumberId}`,
      );
      return false;
    }
    return this.store.markProcessed(message.id);
  }

  private async handleCustomerMessages(
    messages: InboundMessage[],
    operatorWaId: string,
  ): Promise<void> {
    const [first] = messages;
    const last = messages[messages.length - 1];
    const question = messages
      .map((m) => m.text ?? RelayMessages.nonTextPlaceholder(m.type))
      .join('\n');
    const open = this.store.findOpenForCustomer(first.from);
    const id =
      open?.id ??
      this.store.createConsultation({
        customerWaId: first.from,
        customerName: first.contactName,
        customerMessageId: first.id,
        lastCustomerMessageId: last.id,
        question,
      });
    if (open) {
      this.store.appendQuestion(id, question, last.id);
    }
    const result = await this.sender.sendText({
      to: operatorWaId,
      body: RelayMessages.notification(
        id,
        first.contactName ?? 'Cliente',
        first.from,
        question,
        open !== undefined,
      ),
    });

    if (result.kind === 'sent') {
      this.store.recordNotificationSent(id, result.messageId);
      return;
    }
    this.logger.error(
      `Consultation #${id} notification ${result.kind}: ${result.reason}`,
    );
    this.store.recordNotificationFailed(
      id,
      result.kind === 'rejected' ? 'notify_failed' : 'notify_unknown',
      result.reason,
    );
  }

  private async handleOperatorReply(
    message: InboundMessage,
    operatorWaId: string,
  ): Promise<void> {
    const consultation = message.quotedMessageId
      ? this.store.findByNotification(message.quotedMessageId)
      : undefined;
    if (!consultation) {
      return this.notifyOperator(
        operatorWaId,
        RelayMessages.consultationNotFound,
      );
    }
    if (message.text === undefined) {
      return this.notifyOperator(operatorWaId, RelayMessages.onlyText);
    }
    if (!this.store.claimForReply(consultation.id)) {
      return this.notifyOperator(
        operatorWaId,
        this.unavailableNotice(consultation),
      );
    }
    await this.sendReply(consultation, message.text, operatorWaId);
  }

  private async sendReply(
    consultation: Consultation,
    text: string,
    operatorWaId: string,
  ): Promise<void> {
    const result = await this.sender.sendText({
      to: consultation.customerWaId,
      body: text,
      contextMessageId: consultation.lastCustomerMessageId,
    });

    if (result.kind === 'sent') {
      this.store.recordReply(consultation.id, 'replied', result.messageId);
    } else if (result.kind === 'rejected') {
      this.store.recordReply(
        consultation.id,
        'awaiting_reply',
        undefined,
        result.reason,
      );
      await this.notifyOperator(
        operatorWaId,
        RelayMessages.replyRejected(consultation.id, result.reason),
      );
    } else {
      this.store.recordReply(
        consultation.id,
        'reply_unknown',
        undefined,
        result.reason,
      );
      await this.notifyOperator(
        operatorWaId,
        RelayMessages.replyUnknown(consultation.id, result.reason),
      );
    }
  }

  private unavailableNotice(consultation: Consultation): string {
    const status = this.store.getStatus(consultation.id);
    return status === 'replied'
      ? RelayMessages.alreadyReplied(consultation.id)
      : RelayMessages.uncertainPending(consultation.id);
  }

  private async notifyOperator(
    operatorWaId: string,
    body: string,
  ): Promise<void> {
    const result = await this.sender.sendText({ to: operatorWaId, body });
    if (result.kind !== 'sent') {
      this.logger.error(`Operator notice ${result.kind}: ${result.reason}`);
    }
  }
}

type RelayUnit =
  | { kind: 'operator'; message: InboundMessage }
  | { kind: 'customer'; messages: InboundMessage[] };

function groupCustomerBursts(
  messages: InboundMessage[],
  operatorWaId: string,
): RelayUnit[] {
  const units: RelayUnit[] = [];
  const bursts = new Map<string, InboundMessage[]>();
  for (const message of messages) {
    if (message.from === operatorWaId) {
      units.push({ kind: 'operator', message });
      continue;
    }
    const burst = bursts.get(message.from);
    if (burst) {
      burst.push(message);
    } else {
      const created = [message];
      bursts.set(message.from, created);
      units.push({ kind: 'customer', messages: created });
    }
  }
  return units;
}
