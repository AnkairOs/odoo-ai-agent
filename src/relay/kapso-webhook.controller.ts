import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { KapsoSignatureGuard } from '../webhooks/kapso-signature.guard.js';
import { parseReceivedMessages } from './kapso-payload.js';
import { RelayService } from './relay.service.js';

const MESSAGE_RECEIVED = 'whatsapp.message.received';

@Controller('webhooks')
export class KapsoWebhookController {
  constructor(private readonly relay: RelayService) {}

  @Post('kapso')
  @HttpCode(200)
  @UseGuards(KapsoSignatureGuard)
  async receive(
    @Headers('x-webhook-event') event: string | undefined,
    @Body() body: unknown,
  ): Promise<{ status: 'ok' | 'ignored' }> {
    if (event !== MESSAGE_RECEIVED) {
      return { status: 'ignored' };
    }
    await this.relay.handle(parseReceivedMessages(body));
    return { status: 'ok' };
  }
}
