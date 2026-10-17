import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AiService } from '../ai/ai.service.js';
import type {
  StructuredRequest,
  StructuredResult,
  ToolLoopRequest,
  ToolLoopResult,
} from '../ai/ai.types.js';
import { RelayJobProcessor } from './relay-job.processor.js';
import { RelayModule } from './relay.module.js';
import { RelayStore } from './relay.store.js';
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

class FakeAi {
  enabled = false;
  readonly structuredCalls: StructuredRequest<unknown>[] = [];
  private results: unknown[] = [];

  isEnabled() {
    return this.enabled;
  }

  respond(result: unknown) {
    this.results.push(result);
  }

  async generateStructured<T>(
    request: StructuredRequest<T>,
  ): Promise<StructuredResult<T>> {
    this.structuredCalls.push(request as StructuredRequest<unknown>);
    const next = this.results.shift() ?? {
      ok: false,
      reason: 'provider_error',
      detail: 'no fake result queued',
    };
    return next as StructuredResult<T>;
  }

  readonly toolCalls: ToolLoopRequest[] = [];
  private toolResults: ToolLoopResult[] = [];

  suggest(result: ToolLoopResult) {
    this.toolResults.push(result);
  }

  async generateWithTools(request: ToolLoopRequest): Promise<ToolLoopResult> {
    this.toolCalls.push(request);
    return (
      this.toolResults.shift() ?? {
        ok: false,
        reason: 'provider_error',
        detail: 'no fake suggestion queued',
      }
    );
  }
}

function suggestion(text: string): ToolLoopResult {
  return {
    ok: true,
    text,
    toolsExecuted: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function runTool(
  request: ToolLoopRequest | undefined,
  name: string,
  input: unknown,
): Promise<unknown> {
  const execute = request?.tools[name]?.execute;
  if (!execute) {
    throw new Error(`no executable tool ${name}`);
  }
  return execute(input, { toolCallId: 'call-1', messages: [], context: {} });
}

function triage(category: string, confidence: number, reply = '') {
  return {
    ok: true,
    object: { category, confidence, reply },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

class FakeSender implements WhatsAppSender {
  readonly sent: OutgoingText[] = [];
  private queued: SendResult[] = [];
  private gates: Promise<void>[] = [];
  private crashes = 0;
  private counter = 0;

  failNext(result: SendResult) {
    this.queued.push(result);
  }

  throwNext() {
    this.crashes += 1;
  }

  holdNext(): () => void {
    let release = () => {};
    this.gates.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  async sendText(message: OutgoingText): Promise<SendResult> {
    const gate = this.gates.shift();
    if (gate) {
      await gate;
    }
    if (this.crashes > 0) {
      this.crashes -= 1;
      throw new Error('sender exploded');
    }
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
  let ai: FakeAi;
  let jobs: RelayJobProcessor;

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
      .overrideProvider(AiService)
      .useValue(ai)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    jobs = app.get(RelayJobProcessor);
  }

  function deliver(
    payload: unknown,
    event = 'whatsapp.message.received',
    secret = SECRET,
  ) {
    const response = post(payload, event, secret);
    return {
      async expect(status: number) {
        await response.expect(status);
        await jobs.whenIdle();
      },
    };
  }

  function post(
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

  function storedJobs() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db
        .prepare(
          'SELECT tenant_id, status, attempts, last_error FROM relay_jobs ORDER BY id',
        )
        .all();
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-'));
    dbPath = join(dir, 'relay.sqlite');
    ai = new FakeAi();
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

  it('still answers consultations notified before the notifications table existed', async () => {
    await app.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE consultations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_wa_id TEXT NOT NULL, customer_name TEXT,
        customer_message_id TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL,
        notification_message_id TEXT UNIQUE, reply_message_id TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO consultations VALUES (1, '${CUSTOMER_A}', 'Ana', 'wamid.A1', 'Hola', 'awaiting_reply',
        'wamid.LEGACY', NULL, NULL, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z');
    `);
    legacy.close();
    await start();

    await deliver(
      inbound({
        id: 'wamid.OP1',
        from: OPERATOR,
        body: 'respuesta',
        contextId: 'wamid.LEGACY',
      }),
    ).expect(200);

    expect(sender.sent).toEqual([
      { to: CUSTOMER_A, body: 'respuesta', contextMessageId: 'wamid.A1' },
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

  describe('background processing', () => {
    it('acknowledges the webhook before the notification is sent', async () => {
      const release = sender.holdNext();

      await post(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
      ).expect(200);
      expect(sender.sent).toEqual([]);

      release();
      await jobs.whenIdle();
      expect(notificationFor('hola').body).toContain('Consulta #1');
    });

    it('processes deliveries one at a time in arrival order', async () => {
      const release = sender.holdNext();

      await post(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'primero' }),
      ).expect(200);
      await post(
        inbound({ id: 'wamid.B1', from: CUSTOMER_B, body: 'segundo' }),
      ).expect(200);
      expect(sender.sent).toEqual([]);

      release();
      await jobs.whenIdle();
      expect(sender.to(OPERATOR).map((m) => m.body.split('\n')[2])).toEqual([
        'primero',
        'segundo',
      ]);
    });

    it('resumes jobs left pending or processing when the app restarts', async () => {
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'ya avisado' }),
      ).expect(200);
      const store = app.get(RelayStore);
      store.enqueueJob('default', [
        {
          id: 'wamid.B1',
          phoneNumberId: BUSINESS_PHONE_ID,
          from: CUSTOMER_B,
          contactName: 'Beto',
          type: 'text',
          text: 'interrumpido',
        },
      ]);
      store.claimNextJob();
      store.enqueueJob('default', [
        {
          id: 'wamid.B2',
          phoneNumberId: BUSINESS_PHONE_ID,
          from: CUSTOMER_B,
          contactName: 'Beto',
          type: 'text',
          text: 'pendiente',
        },
      ]);
      await app.close();

      await start();
      await jobs.whenIdle();
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'ya avisado' }),
      ).expect(200);

      expect(sender.to(OPERATOR).map((m) => m.body)).toEqual([
        'Consulta #2 · Beto (…2222)\n\ninterrumpido\n\nResponde citando este mensaje para contestarle.',
        'Consulta #2 (continúa) · Beto (…2222)\n\npendiente\n\nResponde citando este mensaje para contestarle.',
      ]);
      expect(storedJobs().map((job) => job.status)).toEqual([
        'done',
        'done',
        'done',
        'done',
      ]);
    });

    it('marks a throwing job as failed and keeps processing later deliveries', async () => {
      sender.throwNext();

      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'explota' }),
      ).expect(200);
      await deliver(
        inbound({ id: 'wamid.B1', from: CUSTOMER_B, body: 'sigue' }),
      ).expect(200);

      expect(sender.sent).toEqual([
        expect.objectContaining({
          to: OPERATOR,
          body: expect.stringContaining('sigue'),
        }),
      ]);
      expect(storedJobs()).toEqual([
        {
          tenant_id: 'default',
          status: 'failed',
          attempts: 1,
          last_error: 'sender exploded',
        },
        { tenant_id: 'default', status: 'done', attempts: 1, last_error: null },
      ]);
    });

    it('creates no job for an invalid signature', async () => {
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'hola' }),
        'whatsapp.message.received',
        'wrong',
      ).expect(401);

      expect(storedJobs()).toEqual([]);
      expect(sender.sent).toEqual([]);
    });
  });

  describe('multi-message customers', () => {
    it('keeps adding messages to the open consultation until the operator replies', async () => {
      await deliver(
        inbound({
          id: 'wamid.A1',
          from: CUSTOMER_A,
          name: 'Ana',
          body: 'Hola',
        }),
      ).expect(200);
      await deliver(
        inbound({
          id: 'wamid.A2',
          from: CUSTOMER_A,
          name: 'Ana',
          body: 'una recarga de $5',
        }),
      ).expect(200);
      await deliver(
        inbound({
          id: 'wamid.B1',
          from: CUSTOMER_B,
          name: 'Beto',
          body: 'otra cosa',
        }),
      ).expect(200);

      expect(sender.to(OPERATOR).map((m) => m.body)).toEqual([
        'Consulta #1 · Ana (…1111)\n\nHola\n\nResponde citando este mensaje para contestarle.',
        'Consulta #1 (continúa) · Ana (…1111)\n\nuna recarga de $5\n\nResponde citando este mensaje para contestarle.',
        'Consulta #2 · Beto (…2222)\n\notra cosa\n\nResponde citando este mensaje para contestarle.',
      ]);
    });

    it('accepts a reply quoting any notification of the consultation, once', async () => {
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'Hola' }),
      ).expect(200);
      await deliver(
        inbound({ id: 'wamid.A2', from: CUSTOMER_A, body: 'una recarga' }),
      ).expect(200);
      const first = notificationId(notificationFor('Hola'));
      const continuation = notificationId(notificationFor('una recarga'));

      await deliver(
        inbound({
          id: 'wamid.OP1',
          from: OPERATOR,
          body: 'Claro, ¿de cuánto?',
          contextId: continuation,
        }),
      ).expect(200);
      await deliver(
        inbound({
          id: 'wamid.OP2',
          from: OPERATOR,
          body: 'otra',
          contextId: first,
        }),
      ).expect(200);

      expect(sender.to(CUSTOMER_A)).toEqual([
        {
          to: CUSTOMER_A,
          body: 'Claro, ¿de cuánto?',
          contextMessageId: 'wamid.A2',
        },
      ]);
      expect(sender.to(OPERATOR).at(-1)?.body).toBe(
        'La consulta #1 ya fue respondida. No se envió nada.',
      );
    });

    it('quotes the last message of a buffered burst when replying', async () => {
      await deliver({
        type: 'whatsapp.message.received',
        batch: true,
        data: [
          inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'Hola' }),
          inbound({
            id: 'wamid.A2',
            from: CUSTOMER_A,
            body: 'una recarga de $5',
          }),
        ],
      }).expect(200);

      await deliver(
        inbound({
          id: 'wamid.OP1',
          from: OPERATOR,
          body: 'Listo',
          contextId: notificationId(notificationFor('Hola')),
        }),
      ).expect(200);

      expect(sender.to(CUSTOMER_A)).toEqual([
        { to: CUSTOMER_A, body: 'Listo', contextMessageId: 'wamid.A2' },
      ]);
    });

    it('opens a new consultation when the customer writes after the reply', async () => {
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'Hola' }),
      ).expect(200);
      await deliver(
        inbound({
          id: 'wamid.OP1',
          from: OPERATOR,
          body: 'Dime',
          contextId: notificationId(notificationFor('Hola')),
        }),
      ).expect(200);

      await deliver(
        inbound({ id: 'wamid.A2', from: CUSTOMER_A, body: 'gracias' }),
      ).expect(200);

      expect(notificationFor('gracias').body.startsWith('Consulta #2 · ')).toBe(
        true,
      );
    });

    it('sends one notification for a buffered burst from the same customer', async () => {
      const batch = {
        type: 'whatsapp.message.received',
        batch: true,
        data: [
          inbound({
            id: 'wamid.A1',
            from: CUSTOMER_A,
            name: 'Ana',
            body: 'Hola',
          }),
          inbound({
            id: 'wamid.A2',
            from: CUSTOMER_A,
            name: 'Ana',
            body: 'buenas',
          }),
          inbound({
            id: 'wamid.A3',
            from: CUSTOMER_A,
            name: 'Ana',
            body: 'una recarga de...',
          }),
        ],
      };

      await deliver(batch).expect(200);

      expect(sender.to(OPERATOR).map((m) => m.body)).toEqual([
        'Consulta #1 · Ana (…1111)\n\nHola\nbuenas\nuna recarga de...\n\nResponde citando este mensaje para contestarle.',
      ]);
    });

    it('recovers a consultation whose first notification failed when the customer writes again', async () => {
      sender.failNext({ kind: 'rejected', reason: 'HTTP 400' });
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'Hola' }),
      ).expect(200);
      await deliver(
        inbound({ id: 'wamid.A2', from: CUSTOMER_A, body: 'una recarga' }),
      ).expect(200);

      await deliver(
        inbound({
          id: 'wamid.OP1',
          from: OPERATOR,
          body: 'Listo',
          contextId: notificationId(notificationFor('una recarga')),
        }),
      ).expect(200);

      expect(
        notificationFor('una recarga').body.startsWith(
          'Consulta #1 (continúa) · ',
        ),
      ).toBe(true);
      expect(sender.to(CUSTOMER_A)).toEqual([
        { to: CUSTOMER_A, body: 'Listo', contextMessageId: 'wamid.A2' },
      ]);
    });
  });

  describe('F1 social triage', () => {
    beforeEach(() => {
      ai.enabled = true;
    });

    it('answers a social closing with the AI reply and creates no consultation', async () => {
      ai.respond(
        triage('social_closing', 0.95, '¡Con gusto, que tengas buen día!'),
      );

      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'gracias' }),
      ).expect(200);

      expect(sender.sent).toEqual([
        { to: CUSTOMER_A, body: '¡Con gusto, que tengas buen día!' },
      ]);
      expect(JSON.stringify(ai.structuredCalls[0]?.messages)).toContain(
        'gracias',
      );
    });

    it.each([
      ['a price', 'Tenemos recargas de $10'],
      ['digits', 'Te esperamos el 5 de mayo'],
      ['several lines', '¡Gracias!\nVuelve pronto'],
      [
        'too much text',
        'Muchas gracias por escribirnos, fue un gusto atenderte y esperamos verte pronto otra vez',
      ],
      ['nothing', '   '],
    ])(
      'replaces an AI reply containing %s with the safe default',
      async (_label, reply) => {
        ai.respond(triage('social_closing', 0.95, reply));

        await deliver(
          inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'gracias' }),
        ).expect(200);

        expect(sender.sent).toEqual([
          { to: CUSTOMER_A, body: '¡A la orden! 😊' },
        ]);
      },
    );

    it.each([
      ['a low-confidence closing', triage('social_closing', 0.5, '¡De nada!')],
      ['a question', triage('question', 0.99)],
      ['other messages', triage('other', 0.9)],
      ['an AI failure', { ok: false, reason: 'timeout', detail: 'slow' }],
    ])(
      'forwards %s to the operator as a consultation',
      async (_label, result) => {
        ai.respond(result);

        await deliver(
          inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'gracias' }),
        ).expect(200);

        expect(sender.to(CUSTOMER_A)).toEqual([]);
        expect(
          notificationFor('gracias').body.startsWith('Consulta #1 · '),
        ).toBe(true);
      },
    );

    it('does not triage messages of a customer with an open consultation', async () => {
      ai.respond(triage('question', 0.99));
      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: '¿hay de $10?' }),
      ).expect(200);

      await deliver(
        inbound({ id: 'wamid.A2', from: CUSTOMER_A, body: 'gracias' }),
      ).expect(200);

      expect(ai.structuredCalls).toHaveLength(1);
      expect(
        notificationFor('gracias').body.startsWith('Consulta #1 (continúa) · '),
      ).toBe(true);
    });

    it('does not call the AI when it is disabled', async () => {
      ai.enabled = false;

      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: 'gracias' }),
      ).expect(200);

      expect(ai.structuredCalls).toEqual([]);
      expect(notificationFor('gracias').body.startsWith('Consulta #1 · ')).toBe(
        true,
      );
    });
  });
  describe('F2 reply suggestions', () => {
    const SUGGESTED = 'Sí, tenemos recargas de $10 😊';

    beforeEach(() => {
      ai.enabled = true;
    });

    async function askWithSuggestion(
      id: string,
      body: string,
      text: string | undefined,
      { from = CUSTOMER_A, continuation = false } = {},
    ) {
      if (!continuation) {
        ai.respond(triage('question', 0.99));
      }
      if (text !== undefined) {
        ai.suggest(suggestion(text));
      }
      await deliver(inbound({ id, from, name: 'Ana', body })).expect(200);
    }

    async function operatorSays(id: string, body: string, quoted: string) {
      await deliver(
        inbound({ id, from: OPERATOR, body, contextId: quoted }),
      ).expect(200);
    }

    it('shows the AI suggestion in the operator notification', async () => {
      await askWithSuggestion('wamid.A1', '¿Hay recargas de $10?', SUGGESTED);

      expect(sender.to(OPERATOR).map((m) => m.body)).toEqual([
        `Consulta #1 · Ana (…1111)\n\n¿Hay recargas de $10?\n\n💡 Sugerencia: ${SUGGESTED}\n\nResponde "ok" citando este mensaje para enviar la sugerencia, o escribe tu propia respuesta.`,
      ]);
      expect(JSON.stringify(ai.toolCalls[0]?.messages)).toContain(
        '¿Hay recargas de $10?',
      );
      expect(Object.keys(ai.toolCalls[0]?.tools ?? {}).sort()).toEqual([
        'get_customer_history',
        'search_past_answers',
      ]);
    });

    it('trims the suggestion before showing it', async () => {
      await askWithSuggestion('wamid.A1', '¿Hay?', `  ${SUGGESTED}\n `);

      expect(notificationFor('¿Hay?').body).toContain(
        `💡 Sugerencia: ${SUGGESTED}\n\nResponde "ok"`,
      );
    });

    it.each(['ok', 'OK', ' Ok '])(
      'sends the suggestion verbatim when the operator answers "%s"',
      async (accept) => {
        await askWithSuggestion('wamid.A1', '¿Hay recargas?', SUGGESTED);

        await operatorSays(
          'wamid.OP1',
          accept,
          notificationId(notificationFor('¿Hay recargas?')),
        );

        expect(sender.to(CUSTOMER_A)).toEqual([
          { to: CUSTOMER_A, body: SUGGESTED, contextMessageId: 'wamid.A1' },
        ]);
      },
    );

    it('relays any other operator text literally', async () => {
      await askWithSuggestion('wamid.A1', '¿Hay recargas?', SUGGESTED);

      await operatorSays(
        'wamid.OP1',
        'ok, pero mañana',
        notificationId(notificationFor('¿Hay recargas?')),
      );

      expect(sender.to(CUSTOMER_A)).toEqual([
        {
          to: CUSTOMER_A,
          body: 'ok, pero mañana',
          contextMessageId: 'wamid.A1',
        },
      ]);
    });

    it.each([
      ['an AI failure', undefined],
      ['an empty suggestion', '   '],
      ['a suggestion over 600 characters', 'a'.repeat(601)],
    ])(
      'keeps the plain notification and relays "ok" literally after %s',
      async (_label, text) => {
        await askWithSuggestion('wamid.A1', '¿Hay recargas?', text);

        await operatorSays(
          'wamid.OP1',
          'ok',
          notificationId(notificationFor('¿Hay recargas?')),
        );

        expect(notificationFor('¿Hay recargas?').body).toBe(
          'Consulta #1 · Ana (…1111)\n\n¿Hay recargas?\n\nResponde citando este mensaje para contestarle.',
        );
        expect(sender.to(CUSTOMER_A)).toEqual([
          { to: CUSTOMER_A, body: 'ok', contextMessageId: 'wamid.A1' },
        ]);
      },
    );

    it('accepts a suggestion of exactly 600 characters', async () => {
      const longest = 'a'.repeat(600);
      await askWithSuggestion('wamid.A1', '¿Hay?', longest);

      expect(notificationFor('¿Hay?').body).toContain(
        `💡 Sugerencia: ${longest}\n`,
      );
    });

    it('does not ask for a suggestion when the AI is disabled', async () => {
      ai.enabled = false;

      await deliver(
        inbound({ id: 'wamid.A1', from: CUSTOMER_A, body: '¿Hay?' }),
      ).expect(200);

      expect(ai.toolCalls).toEqual([]);
    });

    it('gives a continuation its own suggestion and "ok" on it sends that one', async () => {
      await askWithSuggestion('wamid.A1', 'Hola', 'Hola, ¿en qué te ayudo?');
      await askWithSuggestion(
        'wamid.A2',
        'una recarga de $10',
        'Claro, ya te la hago',
        { continuation: true },
      );

      await operatorSays(
        'wamid.OP1',
        'ok',
        notificationId(notificationFor('una recarga de $10')),
      );

      expect(notificationFor('una recarga de $10').body).toContain(
        '💡 Sugerencia: Claro, ya te la hago',
      );
      expect(JSON.stringify(ai.toolCalls[1]?.messages)).toContain(
        'Hola\\nuna recarga de $10',
      );
      expect(sender.to(CUSTOMER_A)).toEqual([
        {
          to: CUSTOMER_A,
          body: 'Claro, ya te la hago',
          contextMessageId: 'wamid.A2',
        },
      ]);
    });

    it('refuses a second "ok" after the consultation was answered', async () => {
      await askWithSuggestion('wamid.A1', '¿Hay recargas?', SUGGESTED);
      const quoted = notificationId(notificationFor('¿Hay recargas?'));

      await operatorSays('wamid.OP1', 'ok', quoted);
      await operatorSays('wamid.OP2', 'ok', quoted);

      expect(sender.to(CUSTOMER_A).map((m) => m.body)).toEqual([SUGGESTED]);
      expect(sender.to(OPERATOR).at(-1)?.body).toBe(
        'La consulta #1 ya fue respondida. No se envió nada.',
      );
    });

    describe('read-only tools', () => {
      async function answered(
        id: string,
        from: string,
        question: string,
        reply: string,
      ) {
        await askWithSuggestion(id, question, undefined, { from });
        await operatorSays(
          `${id}.OP`,
          reply,
          notificationId(notificationFor(question)),
        );
      }

      beforeEach(async () => {
        await answered(
          'wamid.A1',
          CUSTOMER_A,
          '¿Hay recargas de $10?',
          'Sí hay recargas',
        );
        await answered(
          'wamid.B1',
          CUSTOMER_B,
          '¿Venden recargas de $20?',
          'No, solo de $10',
        );
        await answered('wamid.B2', CUSTOMER_B, '¿Abren el domingo?', 'No');
        await askWithSuggestion('wamid.A2', '¿Y de $5?', undefined);
      });

      it('get_customer_history returns only this customer past consultations', async () => {
        const history = await runTool(
          ai.toolCalls.at(-1),
          'get_customer_history',
          {},
        );

        expect(history).toEqual([
          {
            question: '¿Hay recargas de $10?',
            reply: 'Sí hay recargas',
            date: expect.any(String),
          },
        ]);
      });

      it('search_past_answers returns matching replies without phone numbers or names', async () => {
        const found = await runTool(
          ai.toolCalls.at(-1),
          'search_past_answers',
          {
            query: 'RECARGAS',
          },
        );

        expect(found).toEqual([
          { question: '¿Venden recargas de $20?', reply: 'No, solo de $10' },
          { question: '¿Hay recargas de $10?', reply: 'Sí hay recargas' },
        ]);
        const serialized = JSON.stringify(found);
        for (const secret of [CUSTOMER_A, CUSTOMER_B, '1111', '2222', 'Ana']) {
          expect(serialized).not.toContain(secret);
        }
      });

      it('search_past_answers returns nothing for an unmatched query', async () => {
        expect(
          await runTool(ai.toolCalls.at(-1), 'search_past_answers', {
            query: 'zapatos',
          }),
        ).toEqual([]);
      });
    });

    it('works on a database created before replies and suggestions were stored', async () => {
      await app.close();
      rmSync(dbPath, { force: true });
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE consultations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, customer_wa_id TEXT NOT NULL, customer_name TEXT,
          customer_message_id TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL,
          notification_message_id TEXT UNIQUE, reply_message_id TEXT, last_error TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_customer_message_id TEXT);
        CREATE TABLE consultation_notifications (
          message_id TEXT PRIMARY KEY,
          consultation_id INTEGER NOT NULL REFERENCES consultations (id));
        INSERT INTO consultations VALUES (1, '${CUSTOMER_A}', 'Ana', 'wamid.A1', 'recargas viejas', 'awaiting_reply',
          NULL, NULL, NULL, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z', 'wamid.A1');
        INSERT INTO consultation_notifications VALUES ('wamid.LEGACY', 1);
      `);
      legacy.close();
      await start();

      await operatorSays('wamid.OP1', 'ok', 'wamid.LEGACY');
      await askWithSuggestion('wamid.B1', '¿recargas?', SUGGESTED, {
        from: CUSTOMER_B,
      });

      expect(sender.to(CUSTOMER_A)).toEqual([
        { to: CUSTOMER_A, body: 'ok', contextMessageId: 'wamid.A1' },
      ]);
      expect(notificationFor('¿recargas?').body).toContain(
        `💡 Sugerencia: ${SUGGESTED}`,
      );
      expect(
        await runTool(ai.toolCalls.at(-1), 'search_past_answers', {
          query: 'recargas',
        }),
      ).toEqual([{ question: 'recargas viejas', reply: 'ok' }]);
    });
  });
});
