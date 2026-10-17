import { Module } from '@nestjs/common';
import { KapsoWebhookController } from './kapso-webhook.controller.js';
import { RelayJobProcessor } from './relay-job.processor.js';
import { RelayService } from './relay.service.js';
import { RelayStore } from './relay.store.js';
import { KapsoSender, WHATSAPP_SENDER } from './whatsapp-sender.js';

@Module({
  controllers: [KapsoWebhookController],
  providers: [
    RelayJobProcessor,
    RelayService,
    RelayStore,
    { provide: WHATSAPP_SENDER, useClass: KapsoSender },
  ],
})
export class RelayModule {}
