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
import { RelayJobProcessor } from './relay-job.processor.js';

const MESSAGE_RECEIVED = 'whatsapp.message.received';

@Controller('webhooks')
export class KapsoWebhookController {
  constructor(private readonly jobs: RelayJobProcessor) {}

  @Post('kapso')
  @HttpCode(200)
  @UseGuards(KapsoSignatureGuard)
  receive(
    @Headers('x-webhook-event') event: string | undefined,
    @Body() body: unknown,
  ): { status: 'ok' | 'ignored' } {
    if (event !== MESSAGE_RECEIVED) {
      return { status: 'ignored' };
    }
    const messages = parseReceivedMessages(body);
    if (messages.length > 0) {
      this.jobs.enqueue(messages);
    }
    return { status: 'ok' };
  }
}
