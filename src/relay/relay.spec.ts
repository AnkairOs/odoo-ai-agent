import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RelayModule } from './relay.module.js';
import {
  OutgoingText,
  SendResult,
  WHATSAPP_SENDER,
  WhatsAppSender,
} from './whatsapp-sender.js';

const SECRET = 'test-webhook-secret';
const BUSINESS_PHONE_ID = '100000000000001';
const OPERATOR = '15550000001';
const CUSTOMER_A = '15550001111';
const CUSTOMER_B = '15550002222';

class FakeSender implements WhatsAppSender {
  readonly sent: OutgoingText[] = [];
  private queued: SendResult[] = [];
  private counter = 0;

  failNext(result: SendResult) {
    this.queued.push(result);
  }

  async sendText(message: OutgoingText): Promise<SendResult> {
    const forced = this.queued.shift();
    if (forced) {
      return forced;
    }
    this.sent.push(message);
    this.counter += 1;
    return { kind: 'sent', messageId: `wamid.OUT${this.counter}` };
  }

  to(wa: string) {
    return this.sent.filter((m) => m.to === wa);
  }
}

interface InboundOptions {
  id: string;
  from: string;
  body?: string;
  contextId?: string;
  name?: string;
  type?: string;
  phoneNumberId?: string;
}

function inbound(opts: InboundOptions) {
  const phoneNumberId = opts.phoneNumberId ?? BUSINESS_PHONE_ID;
  const type = opts.type ?? 'text';
  return {
    message: {
      id: opts.id,
      timestamp: '1730092800',
      type,
      from: opts.from,
      ...(type === 'text' ? { text: { body: opts.body ?? '' } } : {}),
      ...(opts.contextId
        ? { context: { from: '15559999999', id: opts.contextId } }
        : {}),
    },
    conversation: {
      id: `conv_${opts.from}`,
      contact_name: opts.name ?? 'Cliente',
      phone_number: opts.from,
      phone_number_id: phoneNumberId,
    },
    is_new_conversation: false,
    phone_number_id: phoneNumberId,
  };
}

describe('WhatsApp operator relay (POST /webhooks/kapso)', () => {
  let dir: string;
  let dbPath: string;
  let app: INestApplication;
  let sender: FakeSender;

  async function start() {
    sender = new FakeSender();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [
            () => ({
              KAPSO_WEBHOOK_SECRET: SECRET,
              KAPSO_PHONE_NUMBER_ID: BUSINESS_PHONE_ID,
              RELAY_OPERATOR_WA_ID: OPERATOR,
              RELAY_DB_PATH: dbPath,
            }),
          ],
        }),
        RelayModule,
      ],
    })
      .overrideProvider(WHATSAPP_SENDER)
      .useValue(sender)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  }

  function deliver(
    payload: unknown,
    event = 'whatsapp.message.received',
    secret = SECRET,
  ) {
    const body = JSON.stringify(payload);
    return request(app.getHttpServer())
      .post('/webhooks/kapso')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Event', event)
      .set(
        'X-Webhook-Signature',
        createHmac('sha256', secret).update(body).digest('hex'),
      )
      .send(body);
  }

  function notificationFor(customerMessageText: string): OutgoingText {
    const found = sender
      .to(OPERATOR)
      .find((m) => m.body.includes(customerMessageText));
    if (!found) {
      throw new Error(
        `no operator notification containing "${customerMessageText}"`,
      );
    }
    return found;
  }

  function notificationId(notification: OutgoingText): string {
    const index = sender.sent.indexOf(notification);
    return `wamid.OUT${index + 1}`;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-'));
    dbPath = join(dir, 'relay.sqlite');
    await start();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('notifies the operator with a numbered consultation and the exact customer text', async () => {
    await deliver(
      inbound({
        id: 'wamid.A1',
        from: CUSTOMER_A,
        name: 'Ana',
        body: '¿Tienen talla M?',
      }),
    ).expect(200);

    expect(sender.sent).toEqual([
      {
        to: OPERATOR,
        body: 'Consulta #1 · Ana (…1111)\n\n¿Tienen talla M?\n\nResponde citando este mensaje para contestarle.',
      },
    ]);
  });

  it('sends the operator reply to the original customer literally, quoting their message', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: '¿Precio?' }),
    ).expect(200);
    const literal = '  Sí, cuesta $20 😊\nEnvío gratis.  ';

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: literal,
        contextId: notificationId(notificationFor('¿Precio?')),
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A)).toEqual([
      { to: CUSTOMER_A, body: literal, contextMessageId: 'wamid.A1' },
    ]);
  });

  it('routes the answer only to the customer whose consultation was quoted', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'pregunta A' }),
    ).expect(200);
    await deliver(
      inbound({ id: 'wamid.B1', from: CUSTOMER_B, body: 'pregunta B' }),
    ).expect(200);
    expect(notificationFor('pregunta B').body).toContain('Consulta #2');

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: 'respuesta B',
        contextId: notificationId(notificationFor('pregunta B')),
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A)).toEqual([]);
    expect(sender.to(CUSTOMER_B)).toEqual([
      { to: CUSTOMER_B, body: 'respuesta B', contextMessageId: 'wamid.B1' },
    ]);
  });

  it('ignores a redelivered customer message', async () => {
    const payload = inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' });

    await deliver(payload).expect(200);
    await deliver(payload).expect(200);

    expect(sender.to(OPERATOR)).toHaveLength(1);
  });

  it('ignores a redelivered operator reply', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);
    const reply = inbound({
      id: 'wamid.OP1',
      from: OPERATOR,
      body: 'buenas',
      contextId: notificationId(notificationFor('hola')),
    });

    await deliver(reply).expect(200);
    await deliver(reply).expect(200);

    expect(sender.to(CUSTOMER_A)).toHaveLength(1);
    expect(sender.to(OPERATOR)).toHaveLength(1);
  });

  it('refuses a second reply to an already answered consultation', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);
    const quoted = notificationId(notificationFor('hola'));
    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: 'primera',
        contextId: quoted,
      }),
    ).expect(200);

    await deliver(
      inbound({
        id: 'wamid.OP2',
        from: OPERATOR,
        body: 'segunda',
        contextId: quoted,
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A).map((m) => m.body)).toEqual(['primera']);
    expect(sender.to(OPERATOR).at(-1)?.body).toBe(
      'La consulta #1 ya fue respondida. No se envió nada.',
    );
  });

  it('never relays a quoted reply from someone other than the operator', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);
    const quoted = notificationId(notificationFor('hola'));

    await deliver(
      inbound({
        id: 'wamid.B1',
        from: CUSTOMER_B,
        body: 'mensaje intruso',
        contextId: quoted,
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A)).toEqual([]);
    expect(notificationFor('mensaje intruso').body).toContain('Consulta #2');
  });

  it.each([
    ['without a quote', undefined],
    ['quoting an unknown message', 'wamid.UNKNOWN'],
  ])(
    'tells the operator how to answer when the reply arrives %s',
    async (_label, contextId) => {
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
      ).expect(200);

      await deliver(
        inbound({
          id: 'wamid.OP1',
          from: OPERATOR,
          body: 'respuesta',
          contextId,
        }),
      ).expect(200);

      expect(sender.to(CUSTOMER_A)).toEqual([]);
      expect(sender.to(OPERATOR).at(-1)?.body).toBe(
        'No encontré la consulta. Responde citando (deslizando) la notificación de la consulta. No se envió nada.',
      );
    },
  );

  it('does not relay a non-text operator reply', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        type: 'image',
        contextId: notificationId(notificationFor('hola')),
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A)).toEqual([]);
    expect(sender.to(OPERATOR).at(-1)?.body).toBe(
      'Solo puedo reenviar respuestas de texto. No se envió nada.',
    );
  });

  it('keeps consultations across restarts', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'antes del reinicio' }),
    ).expect(200);
    const quoted = notificationId(notificationFor('antes del reinicio'));
    await app.close();
    await start();

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: 'después',
        contextId: quoted,
      }),
    ).expect(200);
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'antes del reinicio' }),
    ).expect(200);

    expect(sender.sent).toEqual([
      { to: CUSTOMER_A, body: 'después', contextMessageId: 'wamid.A1' },
    ]);
  });

  it('rejects an invalid signature with 401 and no effects', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
      'whatsapp.message.received',
      'wrong',
    ).expect(401);
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);

    expect(sender.to(OPERATOR)).toHaveLength(1);
  });

  it('ignores messages addressed to another phone number id', async () => {
    await deliver(
      inbound({
        id: 'wamid.A1',
        from: CUSTOMER_A,
        body: 'hola',
        phoneNumberId: '999',
      }),
    ).expect(200);

    expect(sender.sent).toEqual([]);
  });

  it('ignores events other than whatsapp.message.received', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
      'whatsapp.message.sent',
    ).expect(200);

    expect(sender.sent).toEqual([]);
  });

  it('processes every message of a buffered batch', async () => {
    const batch = {
      type: 'whatsapp.message.received',
      batch: true,
      data: [
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'uno' }),
        inbound({ id: 'wamid.B1', from: CUSTOMER_B, body: 'dos' }),
      ],
    };

    await deliver(batch).expect(200);

    expect(sender.to(OPERATOR).map((m) => m.body.split('\n')[2])).toEqual([
      'uno',
      'dos',
    ]);
  });

  it('forwards non-text customer messages with a placeholder', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, type: 'image' }),
    ).expect(200);

    expect(
      notificationFor('[El cliente envió un mensaje de tipo image sin texto]')
        .body,
    ).toContain('Consulta #1');
  });

  it('does not resend a failed notification when the customer message is redelivered', async () => {
    sender.failNext({ kind: 'unknown', reason: 'timeout' });
    const payload = inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' });

    await deliver(payload).expect(200);
    await deliver(payload).expect(200);

    expect(sender.sent).toEqual([]);
  });

  it('lets the operator retry after a definite rejection', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);
    const quoted = notificationId(notificationFor('hola'));
    sender.failNext({ kind: 'rejected', reason: 'HTTP 400' });

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: 'intento 1',
        contextId: quoted,
      }),
    ).expect(200);
    expect(sender.to(OPERATOR).at(-1)?.body).toBe(
      'No se pudo enviar la respuesta a la consulta #1 (HTTP 400). Puedes intentarlo de nuevo citando la notificación.',
    );
    await deliver(
      inbound({
        id: 'wamid.OP2',
        from: OPERATOR,
        body: 'intento 2',
        contextId: quoted,
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A)).toEqual([
      { to: CUSTOMER_A, body: 'intento 2', contextMessageId: 'wamid.A1' },
    ]);
  });

  it('blocks further replies when the send outcome is unknown', async () => {
    await deliver(
      inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
    ).expect(200);
    const quoted = notificationId(notificationFor('hola'));
    sender.failNext({ kind: 'unknown', reason: 'timeout' });

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: 'intento 1',
        contextId: quoted,
      }),
    ).expect(200);
    await deliver(
      inbound({
        id: 'wamid.OP2',
        from: OPERATOR,
        body: 'intento 2',
        contextId: quoted,
      }),
    ).expect(200);

    expect(sender.to(CUSTOMER_A)).toEqual([]);
    expect(
      sender
        .to(OPERATOR)
        .slice(-2)
        .map((m) => m.body),
    ).toEqual([
      'No sé si la respuesta a la consulta #1 llegó (timeout). Verifica en Kapso antes de volver a escribirle; no se reintentará automáticamente.',
      'La consulta #1 tiene un envío con resultado incierto. Verifica en Kapso; no se envió nada.',
    ]);
  });
});
