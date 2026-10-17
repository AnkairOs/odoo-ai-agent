import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { CustomerTriage } from './customer-triage.js';
import { KapsoWebhookController } from './kapso-webhook.controller.js';
import { RelayJobProcessor } from './relay-job.processor.js';
import { RelayService } from './relay.service.js';
import { RelayStore } from './relay.store.js';
import { ReplySuggester } from './reply-suggester.js';
import { KapsoSender, WHATSAPP_SENDER } from './whatsapp-sender.js';

@Module({
  imports: [AiModule],
  controllers: [KapsoWebhookController],
  providers: [
    CustomerTriage,
    RelayJobProcessor,
    RelayService,
    RelayStore,
    ReplySuggester,
    { provide: WHATSAPP_SENDER, useClass: KapsoSender },
  ],
})
export class RelayModule {}
