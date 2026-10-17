import { Module } from '@nestjs/common';
import { KapsoWebhookController } from './kapso-webhook.controller.js';
import { RelayService } from './relay.service.js';
import { RelayStore } from './relay.store.js';
import { KapsoSender, WHATSAPP_SENDER } from './whatsapp-sender.js';

@Module({
  controllers: [KapsoWebhookController],
  providers: [
    RelayService,
    RelayStore,
    { provide: WHATSAPP_SENDER, useClass: KapsoSender },
  ],
})
export class RelayModule {}
