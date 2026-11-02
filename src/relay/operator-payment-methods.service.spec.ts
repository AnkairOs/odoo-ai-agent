import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { AiService } from '../ai/ai.service.js';
import { OdooClientService } from '../odoo/odoo-client.service.js';
import { OdooProductCreationService } from '../odoo/odoo-product-creation.service.js';
import { OdooProductUpdateService } from '../odoo/odoo-product-update.service.js';
import { OdooProductsService } from '../odoo/odoo-products.service.js';
import { OdooTaxesService } from '../odoo/odoo-taxes.service.js';
import { OdooPaymentMethodsService } from '../odoo/odoo-payment-methods.service.js';
import { OperatorConversationService } from './operator-conversation.service.js';
import { RelayStore } from './relay.store.js';
import type { InboundMessage } from './kapso-payload.js';
import type { OutgoingText, SendResult } from './whatsapp-sender.js';

type Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const text = (value: string): Result => ({
  content: [{ type: 'text', text: value }],
  usage,
  finishReason: { unified: 'stop', raw: 'stop' },
  warnings: [],
});

const call = (name: string, input: unknown, id = 'pm-call-1'): Result => ({
  content: [{ type: 'tool-call', toolName: name, input: JSON.stringify(input), toolCallId: id }],
  usage,
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  warnings: [],
});

const decision = (value: string) => text(JSON.stringify({ decision: value }));

const ENV = {
  AI_ENABLED: 'true',
  DEEPSEEK_API_KEY: 'test-only',
  RELAY_OPERATOR_WA_ID: 'operator',
  KAPSO_PHONE_NUMBER_ID: 'business',
  ODOO_DEFAULT_URL: 'https://odoo.test',
  ODOO_DEFAULT_DB: 'catalog',
  ODOO_DEFAULT_API_KEY: 'test-only',
  ODOO_PRODUCT_COMPANY_ID: '7',
  ODOO_PRODUCT_CREATION_ENABLED: 'true',
  RELAY_DB_PATH: ':memory:',
};

function setup(results: (Result | Error)[]) {
  const config = new ConfigService(ENV);
  const queue = [...results];
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('No mocked model result');
      return next;
    },
  });
  const ai = new AiService(config, () => ({ model }));
  const store = new RelayStore(config);
  store.onModuleInit();

  const sent: OutgoingText[] = [];
  const sendText = vi.fn(async (outgoing: OutgoingText): Promise<SendResult> => {
    sent.push(outgoing);
    return { kind: 'sent', messageId: `out-${sent.length}` };
  });

  const client = new OdooClientService(config);
  const creation = new OdooProductCreationService(config);
  const updateService = new OdooProductUpdateService(config);
  const products = new OdooProductsService(client, config);
  const taxes = new OdooTaxesService(client, config);
  const paymentMethods = new OdooPaymentMethodsService(client, config);

  const service = new OperatorConversationService(
    config,
    store,
    ai,
    products,
    creation,
    updateService,
    taxes,
    { sendText },
    undefined,
    paymentMethods,
  );

  let event = 0;
  const message = (body: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    id: `event-${++event}`,
    from: 'operator',
    phoneNumberId: 'business',
    type: 'text',
    text: body,
    ...extra,
  });
  const say = (body: string, extra: Partial<InboundMessage> = {}) => service.handle(message(body, extra));

  return { config, model, store, service, paymentMethods, sent, say, message };
}

describe('OperatorConversationService - Payment Methods', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes payment methods tools when paymentMethods service is present', async () => {
    const h = setup([text('Hola! En qué puedo ayudarte?')]);
    await h.say('Hola');
    const tools = h.model.doGenerateCalls[0].tools;
    const names = tools?.map((t) => t.name);
    expect(names).toContain('get_payment_methods');
    expect(names).toContain('create_payment_method');
    expect(names).toContain('update_payment_method');
    expect(names).toContain('archive_payment_method');
  });

  it('lists registered payment methods via get_payment_methods', async () => {
    const h = setup([
      call('get_payment_methods', {}),
      text('Tenemos registrada la cuenta de Banco Pichincha 2200112233 a nombre de Juan Perez.'),
    ]);

    vi.spyOn(h.paymentMethods, 'list').mockResolvedValue({
      status: 'ok',
      methods: [
        {
          id: 10,
          accNumber: '2200112233',
          accHolderName: 'Juan Perez',
          bankName: 'Banco Pichincha',
          note: 'Ahorros',
          active: true,
        },
      ],
    });

    await h.say('¿Qué cuentas bancarias tenemos registradas?');

    expect(h.paymentMethods.list).toHaveBeenCalled();
    expect(h.sent.at(-1)?.body).toContain('Banco Pichincha');
  });

  it('proposes create_payment_method with preview and executes on confirmation', async () => {
    const h = setup([
      // Step 1: LLM proposes create_payment_method
      call('create_payment_method', {
        accNumber: '1799223344',
        bankName: 'Banco Guayaquil',
        accHolderName: 'Mi Negocio S.A.',
        note: 'Cuenta corriente',
      }),
      // Step 2: Classifier sees "sí" and decides "approve"
      decision('approve'),
      // Step 3: Follow-up generation after tool execution
      text('Listo ✅ Registré la cuenta.'),
    ]);

    vi.spyOn(h.paymentMethods, 'create').mockResolvedValue({
      status: 'created',
      id: 55,
    });

    // Operator asks to add account
    await h.say('Agrega la cuenta del Banco Guayaquil 1799223344 a nombre de Mi Negocio S.A.');

    // Proposal preview must have been sent
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toContain('Voy a registrar la siguiente cuenta en Odoo:');
    expect(h.sent[0].body).toContain('Banco Guayaquil');
    expect(h.sent[0].body).toContain('1799223344');
    expect(h.sent[0].body).toContain('¿La agrego? Responde «sí» o «ok» para confirmarla o «no» para cancelar.');

    // Operator confirms
    await h.say('sí');

    expect(h.paymentMethods.create).toHaveBeenCalledWith({
      accNumber: '1799223344',
      bankName: 'Banco Guayaquil',
      accHolderName: 'Mi Negocio S.A.',
      note: 'Cuenta corriente',
    });
    expect(h.sent.at(-1)?.body).toContain('Listo ✅ Registré la cuenta 1799223344 (Banco Guayaquil) en Odoo.');
  });

  it('cancels create_payment_method on "no"', async () => {
    const h = setup([
      call('create_payment_method', {
        accNumber: '111222333',
        bankName: 'Pichincha',
      }),
      decision('reject'),
    ]);

    await h.say('Agrega la cuenta 111222333 de Pichincha');
    expect(h.sent[0].body).toContain('Voy a registrar la siguiente cuenta en Odoo:');

    await h.say('no');
    expect(h.sent.at(-1)?.body).toBe('Listo, no registré la cuenta.');
  });

  it('proposes update_payment_method with comparative preview and updates on confirmation', async () => {
    const h = setup([
      call('update_payment_method', {
        id: 10,
        accHolderName: 'Carlos Ramirez',
      }),
      decision('approve'),
      text('Listo ✅ Actualicé la cuenta.'),
    ]);

    vi.spyOn(h.paymentMethods, 'getById').mockResolvedValue({
      id: 10,
      accNumber: '2200112233',
      accHolderName: 'Juan Perez',
      bankName: 'Banco Pichincha',
      active: true,
    });

    vi.spyOn(h.paymentMethods, 'update').mockResolvedValue({
      status: 'updated',
      id: 10,
    });

    await h.say('Cambia el titular de la cuenta 10 a Carlos Ramirez');

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toContain('Voy a actualizar la cuenta 2200112233 (Banco Pichincha) en Odoo:');
    expect(h.sent[0].body).toContain('Titular: Juan Perez ➔ Carlos Ramirez');

    await h.say('sí');

    expect(h.paymentMethods.update).toHaveBeenCalledWith({
      id: 10,
      accHolderName: 'Carlos Ramirez',
    });
    expect(h.sent.at(-1)?.body).toContain('Listo ✅ Actualicé la cuenta 2200112233 en Odoo.');
  });

  it('proposes archive_payment_method with deactivation preview and archives on confirmation', async () => {
    const h = setup([
      call('archive_payment_method', {
        id: 10,
      }),
      decision('approve'),
      text('Listo ✅ Desactivé la cuenta.'),
    ]);

    vi.spyOn(h.paymentMethods, 'getById').mockResolvedValue({
      id: 10,
      accNumber: '2200112233',
      bankName: 'Banco Pichincha',
      active: true,
    });

    vi.spyOn(h.paymentMethods, 'archive').mockResolvedValue({
      status: 'archived',
      id: 10,
    });

    await h.say('Desactiva la cuenta 10');

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toContain('Voy a desactivar la cuenta 2200112233 (Banco Pichincha) en Odoo. Ya no se usará para cobros.');

    await h.say('sí');

    expect(h.paymentMethods.archive).toHaveBeenCalledWith(10);
    expect(h.sent.at(-1)?.body).toContain('Listo ✅ Desactivé la cuenta 2200112233 (Banco Pichincha) en Odoo.');
  });
});
