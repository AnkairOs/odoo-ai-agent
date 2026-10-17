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
    for (const message of messages) {
      await this.handleOne(message);
    }
  }

  private async handleOne(message: InboundMessage): Promise<void> {
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
    if (message.phoneNumberId !== businessPhoneId) {
      this.logger.warn(
        `Ignoring message for unexpected phone number id ${message.phoneNumberId}`,
      );
      return;
    }
    if (!this.store.markProcessed(message.id)) {
      return;
    }
    if (message.from === operatorWaId) {
      await this.handleOperatorReply(message, operatorWaId);
    } else {
      await this.handleCustomerMessage(message, operatorWaId);
    }
  }

  private async handleCustomerMessage(
    message: InboundMessage,
    operatorWaId: string,
  ): Promise<void> {
    const question =
      message.text ?? RelayMessages.nonTextPlaceholder(message.type);
    const id = this.store.createConsultation({
      customerWaId: message.from,
      customerName: message.contactName,
      customerMessageId: message.id,
      question,
    });
    const result = await this.sender.sendText({
      to: operatorWaId,
      body: RelayMessages.notification(
        id,
        message.contactName ?? 'Cliente',
        message.from,
        question,
      ),
    });

    if (result.kind === 'sent') {
      this.store.recordNotification(id, 'awaiting_reply', result.messageId);
      return;
    }
    this.logger.error(
      `Consultation #${id} notification ${result.kind}: ${result.reason}`,
    );
    this.store.recordNotification(
      id,
      result.kind === 'rejected' ? 'notify_failed' : 'notify_unknown',
      undefined,
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
      contextMessageId: consultation.customerMessageId,
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
