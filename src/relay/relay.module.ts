import { Module } from '@nestjs/common';
import { OperatorProductsService } from './operator-products.service.js';
import { OperatorConversationService } from './operator-conversation.service.js';
import { AiModule } from '../ai/ai.module.js';
import { OdooModule } from '../odoo/odoo.module.js';
import { CustomerTriage } from './customer-triage.js';
import { KapsoWebhookController } from './kapso-webhook.controller.js';
import { RelayJobProcessor } from './relay-job.processor.js';
import { RelayService } from './relay.service.js';
import { RelayStore } from './relay.store.js';
import { ReplySuggester } from './reply-suggester.js';
import { KapsoSender, WHATSAPP_SENDER } from './whatsapp-sender.js';

@Module({
  imports: [AiModule, OdooModule],
  controllers: [KapsoWebhookController],
  providers: [
    CustomerTriage,
    OperatorProductsService,
    OperatorConversationService,
    RelayJobProcessor,
    RelayService,
    RelayStore,
    ReplySuggester,
    { provide: WHATSAPP_SENDER, useClass: KapsoSender },
  ],
})
export class RelayModule {}
