import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Controller,
  HttpCode,
  INestApplication,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { KapsoSignatureGuard } from './kapso-signature.guard.js';

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({
  message: { id: 'wamid.TEST', text: { body: 'Hola' } },
});

const handled = vi.fn();

@Controller('signed')
class SignedTestController {
  @Post()
  @HttpCode(200)
  @UseGuards(KapsoSignatureGuard)
  receive() {
    handled();
    return 'OK';
  }
}

function sign(payload: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('KapsoSignatureGuard', () => {
  let app: INestApplication;

  async function createApp(env: Record<string, string>) {
    const moduleRef = await Test.createTestingModule({
      controllers: [SignedTestController],
      providers: [
        KapsoSignatureGuard,
        { provide: ConfigService, useValue: new ConfigService(env) },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  }

  function post(signature?: string, body = BODY) {
    const req = request(app.getHttpServer())
      .post('/signed')
      .set('Content-Type', 'application/json');
    if (signature !== undefined) {
      req.set('X-Webhook-Signature', signature);
    }
    return req.send(body);
  }

  afterEach(async () => {
    handled.mockClear();
    await app.close();
  });

  it('accepts a hex HMAC-SHA256 of the exact raw body', async () => {
    await createApp({ KAPSO_WEBHOOK_SECRET: SECRET });

    await post(sign(BODY)).expect(200);

    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('accepts the signature of the raw bytes even when JSON formatting differs from re-serialization', async () => {
    await createApp({ KAPSO_WEBHOOK_SECRET: SECRET });
    const spacedBody = '{ "message" :  { "id": "wamid.TEST" } }';

    await post(sign(spacedBody), spacedBody).expect(200);

    expect(handled).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['signed with another secret', sign(BODY, 'other-secret')],
    ['signed over different bytes', sign(`${BODY} `)],
    ['prefixed with sha256=', `sha256=${sign(BODY)}`],
    ['uppercase hex', sign(BODY).toUpperCase()],
    ['truncated', sign(BODY).slice(0, 32)],
  ])(
    'rejects a %s signature with 401 and no effect',
    async (_label, signature) => {
      await createApp({ KAPSO_WEBHOOK_SECRET: SECRET });

      await post(signature).expect(401);

      expect(handled).not.toHaveBeenCalled();
    },
  );

  it('fails closed when no secret is configured', async () => {
    await createApp({});

    await post(sign(BODY, '')).expect(401);

    expect(handled).not.toHaveBeenCalled();
  });
});
