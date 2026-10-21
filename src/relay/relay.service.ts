import { Inject, Injectable, Logger } from '@nestjs/common';
import { OperatorProductsService } from './operator-products.service.js';
import { OperatorConversationService } from './operator-conversation.service.js';
import { ConfigService } from '@nestjs/config';
import { CustomerTriage } from './customer-triage.js';
import { InboundMessage } from './kapso-payload.js';
import { RelayMessages } from './relay.messages.js';
import { Consultation, RelayStore } from './relay.store.js';
import { ReplySuggester } from './reply-suggester.js';
import { WHATSAPP_SENDER } from './whatsapp-sender.js';
import type { WhatsAppSender } from './whatsapp-sender.js';
import { OdooOperatorService } from '../odoo/odoo-operator.service.js';

@Injectable()
export class RelayService {
  private readonly logger = new Logger(RelayService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly store: RelayStore,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsAppSender,
    private readonly triage: CustomerTriage,
    private readonly suggester: ReplySuggester,
    private readonly products: OperatorProductsService,
    private readonly conversation: OperatorConversationService,
    private readonly operatorService: OdooOperatorService,
  ) {}

  async handle(message: InboundMessage): Promise<boolean>;
  async handle(messages: InboundMessage[]): Promise<boolean>;
  async handle(input: InboundMessage | InboundMessage[]): Promise<boolean> {
    const businessPhoneId = this.configService.get<string>(
      'KAPSO_PHONE_NUMBER_ID',
    );
    const operatorWaId = await this.resolveOperatorWaId();
    if (!businessPhoneId || !operatorWaId) {
      this.logger.error(
        'Relay is not configured (KAPSO_PHONE_NUMBER_ID / RELAY_OPERATOR_WA_ID); message ignored',
      );
      return false;
    }

    if (!Array.isArray(input)) {
      if (input.from !== operatorWaId && !this.store.isCustomerInquiriesEnabled()) {
        return true;
      }
    }

    const messages = Array.isArray(input) ? input : [input];
    const fresh = messages.filter((message) =>
      this.accept(message, businessPhoneId),
    );
    for (const unit of groupCustomerBursts(fresh, operatorWaId)) {
      if (unit.kind === 'operator') {
        await this.handleOperatorReply(unit.message, operatorWaId);
      } else {
        if (!this.store.isCustomerInquiriesEnabled()) {
          continue;
        }
        await this.handleCustomerMessages(unit.messages, operatorWaId);
      }
    }
    return true;
  }

  private async resolveOperatorWaId(): Promise<string | undefined> {
    const configured = this.configService.get<string>('RELAY_OPERATOR_WA_ID');
    if (configured === 'operator') {
      return 'operator';
    }
    return (await this.operatorService.resolveOperatorPhone()) ?? configured;
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
    if (!open && (await this.answeredByTriage(first.from, question))) {
      return;
    }
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
    const suggestion = await this.suggester.suggest(id, first.from);
    const result = await this.sender.sendText({
      to: operatorWaId,
      body: RelayMessages.notification(
        id,
        first.contactName ?? 'Cliente',
        first.from,
        question,
        open !== undefined,
        suggestion,
      ),
    });

    if (result.kind === 'sent') {
      this.store.recordNotificationSent(id, result.messageId, suggestion);
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

  private async answeredByTriage(
    customerWaId: string,
    text: string,
  ): Promise<boolean> {
    const decision = await this.triage.decide(text);
    if (decision.kind !== 'auto_reply') {
      return false;
    }
    const result = await this.sender.sendText({
      to: customerWaId,
      body: decision.reply,
    });
    if (result.kind !== 'sent') {
      this.logger.error(
        `Automatic closing reply ${result.kind}: ${result.reason}; forwarding to the operator`,
      );
      return false;
    }
    return true;
  }

  private async handleOperatorReply(
    message: InboundMessage,
    operatorWaId: string,
  ): Promise<void> {
    if (await this.products.handle(message)) return;
    if (await this.conversation.handle(message)) return;
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
    if (consultation.status !== 'awaiting_reply') {
      return this.notifyOperator(operatorWaId, this.unavailableNotice(consultation));
    }
    const command = /^\s*\/enviar(?:\s([\s\S]*)|$)/u.exec(message.text);
    let text: string;
    if (command) {
      text = command[1] ?? '';
      if (!text.trim()) {
        return this.notifyOperator(operatorWaId, RelayMessages.sendUsage);
      }
    } else if (isAcceptance(message.text)) {
      if (consultation.suggestion === undefined) {
        return this.notifyOperator(operatorWaId, RelayMessages.noDraft);
      }
      if (!this.store.isCurrentNotification(consultation.id, message.quotedMessageId!)) {
        return this.notifyOperator(operatorWaId, RelayMessages.staleDraft);
      }
      text = consultation.suggestion;
    } else {
      const draft = await this.suggester.revise(
        consultation.id,
        consultation.customerWaId,
        consultation.suggestion,
        message.text,
      );
      if (draft === undefined) {
        return this.notifyOperator(operatorWaId, RelayMessages.draftUnavailable);
      }
      const result = await this.sender.sendText({
        to: operatorWaId,
        body: RelayMessages.proposal(consultation.id, draft),
      });
      if (result.kind === 'sent') {
        this.store.recordNotificationSent(consultation.id, result.messageId, draft);
      } else {
        this.logger.error(`Private draft ${result.kind}: ${result.reason}`);
      }
      return;
    }
    if (!this.store.claimForReply(consultation.id)) {
      return this.notifyOperator(operatorWaId, this.unavailableNotice(consultation));
    }
    await this.sendReply(consultation, text, operatorWaId);
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
      this.store.recordReplySent(consultation.id, result.messageId, text);
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

function isAcceptance(text: string): boolean {
  return text.trim().toLowerCase() === 'ok';
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
