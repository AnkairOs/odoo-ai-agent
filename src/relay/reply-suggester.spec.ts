import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiService } from '../ai/ai.service.js';
import type { ToolLoopRequest, ToolLoopResult } from '../ai/ai.types.js';
import { OdooClientService } from '../odoo/odoo-client.service.js';
import { OdooProductsService } from '../odoo/odoo-products.service.js';
import { RelayStore } from './relay.store.js';
import { ReplySuggester } from './reply-suggester.js';

const draft: ToolLoopResult = {
  ok: true, text: 'Déjame confirmar.', toolsExecuted: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

async function lookup(request: ToolLoopRequest, input: unknown) {
  const tool = request.tools.search_odoo_products;
  expect(tool).toBeDefined();
  if (!tool?.execute) throw new Error('Product tool missing');
  return tool.execute(input, { toolCallId: 'lookup', messages: [], context: {} });
}

describe('ReplySuggester product lookup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['suggest', 'revise'] as const)('offers fixed lookup during %s without changing history messages', async (mode) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/search_read')) {
        return new Response(JSON.stringify([{ id: 1, name: 'Cable', default_code: 'CB1', list_price: 25, taxes_id: [1] }]));
      }
      if (u.endsWith('/search_count')) return new Response('1');
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const config = new ConfigService({ ODOO_DEFAULT_URL: 'https://odoo.example.invalid', ODOO_DEFAULT_DB: 'business', ODOO_DEFAULT_API_KEY: 'mock-key' });
    const service = new OdooProductsService(new OdooClientService(config), config);
    const generateWithTools = vi.fn(async (request: ToolLoopRequest) => {
      expect(Object.keys(request.tools).sort()).toEqual(['get_customer_history', 'search_odoo_products', 'search_past_answers']);
      expect(request.system).toContain('Product results are real catalog data');
      expect(request.system).toContain('omit query to see the active catalog');
      const schema = request.tools.search_odoo_products?.inputSchema;
      if (!(schema instanceof z.ZodType)) throw new Error('Missing product schema');
      for (const input of [
        { query: '' }, { query: '   ' }, { query: 'x'.repeat(121) },
        { query: 'Cable', url: 'https://other.invalid', db: 'other', company: 2 },
        { query: 'Cable', model: 'res.users', method: 'unlink', domain: [] },
      ]) {
        expect(schema.safeParse(input).success).toBe(false);
      }
      expect(schema.safeParse({ query: 'x'.repeat(120) }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ offset: 0 }).success).toBe(true);
      expect(schema.safeParse({ query: 'Cable', offset: 5 }).success).toBe(true);
      expect(await lookup(request, { query: 'Cable' })).toEqual({
        status: 'ok',
        products: [{ id: 1, name: 'Cable', default_code: 'CB1', list_price: 25, taxes_id: [1] }],
        total: 1,
        offset: 0,
      });
      expect(request.messages).toEqual([
        { role: 'user', content: 'Anterior' }, { role: 'assistant', content: 'Respuesta' },
        { role: 'user', content: mode === 'suggest' ? 'Cable' : JSON.stringify({ question: 'Cable', quotedDraft: 'Borrador', instruction: 'Busca Cable' }) },
      ]);
      return draft;
    });
    const store = { getQuestion: vi.fn(() => 'Cable'), customerHistory: vi.fn(() => [{ question: 'Anterior', reply: 'Respuesta' }]) };
    const suggester = new ReplySuggester({ isEnabled: () => true, generateWithTools } as unknown as AiService, store as unknown as RelayStore, service);
    expect(await (mode === 'suggest' ? suggester.suggest(2, 'customer') : suggester.revise(2, 'customer', 'Borrador', 'Busca Cable'))).toBe('Déjame confirmar.');
    expect(store.customerHistory).toHaveBeenCalledWith('customer', 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['suggest', 'revise'] as const)('keeps %s usable when lookup fails or is unconfigured', async (mode) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    for (const configured of [false, true]) {
      const config = new ConfigService(configured ? { ODOO_DEFAULT_URL: 'https://odoo.example.invalid', ODOO_DEFAULT_DB: 'business', ODOO_DEFAULT_API_KEY: 'mock-key' } : {});
      fetchMock.mockResolvedValue(new Response('private traceback', { status: 500 }));
      const service = new OdooProductsService(new OdooClientService(config), config);
      const generateWithTools = vi.fn(async (request: ToolLoopRequest) => {
        expect(await lookup(request, { query: 'Cable' })).toEqual({ status: 'unavailable' });
        return draft;
      });
      const suggester = new ReplySuggester({ isEnabled: () => true, generateWithTools } as unknown as AiService, { getQuestion: () => 'Cable', customerHistory: () => [] } as unknown as RelayStore, service);
      expect(await (mode === 'suggest' ? suggester.suggest(1, 'customer') : suggester.revise(1, 'customer', undefined, 'Busca Cable'))).toBe('Déjame confirmar.');
      if (!configured) expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it.each(['suggest', 'revise'] as const)('tells %s to name matching products and include list_price if requested', async (mode) => {
    const generateWithTools = vi.fn(async (_request: ToolLoopRequest) => draft);
    const suggester = new ReplySuggester({ isEnabled: () => true, generateWithTools } as unknown as AiService, { getQuestion: () => 'Radio', customerHistory: () => [] } as unknown as RelayStore, { search: vi.fn() } as unknown as OdooProductsService);
    await (mode === 'suggest' ? suggester.suggest(1, 'customer') : suggester.revise(1, 'customer', undefined, 'Responde'));
    expect(generateWithTools).toHaveBeenCalledOnce();
    expect(generateWithTools.mock.calls[0][0].system).toContain('When search_odoo_products returns matching products, name them in the draft (at most five). If the customer asked for prices, you may state the price from list_price. Never invent prices or discounts not returned by Odoo.');
  });

  it('never invokes AI or lookup with AI disabled', async () => {
    const generateWithTools = vi.fn();
    const search = vi.fn();
    const suggester = new ReplySuggester({ isEnabled: () => false, generateWithTools } as unknown as AiService, { getQuestion: () => 'Cable' } as unknown as RelayStore, { search } as unknown as OdooProductsService);
    expect(await suggester.suggest(1, 'customer')).toBeUndefined();
    expect(await suggester.revise(1, 'customer', undefined, 'Busca Cable')).toBeUndefined();
    expect(generateWithTools).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('calls products.search({ offset: 0 }) when search_odoo_products query is omitted and suggests matching products', async () => {
    const productsService = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        products: [
          { id: 1, name: 'Disney + premium 1 perfil', default_code: 'DIS1', list_price: 3.5, taxes_id: [] },
          { id: 2, name: 'Crunchyroll 1 perfil', default_code: 'CR1', list_price: 2.5, taxes_id: [] },
        ],
        total: 2,
        offset: 0,
      }),
    };
    const generateWithTools = vi.fn(async (request: ToolLoopRequest) => {
      const tool = request.tools.search_odoo_products;
      expect(tool).toBeDefined();
      const result = await tool!.execute({ offset: 0 }, { toolCallId: 't1', messages: [], context: {} });
      expect(result).toEqual({
        status: 'ok',
        products: [
          { id: 1, name: 'Disney + premium 1 perfil', default_code: 'DIS1', list_price: 3.5, taxes_id: [] },
          { id: 2, name: 'Crunchyroll 1 perfil', default_code: 'CR1', list_price: 2.5, taxes_id: [] },
        ],
        total: 2,
        offset: 0,
      });
      return {
        ok: true,
        text: 'Contamos con Disney + premium 1 perfil ($3.50) y Crunchyroll 1 perfil ($2.50).',
        toolsExecuted: ['search_odoo_products'],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });
    const store = {
      getQuestion: vi.fn(() => '¿Qué productos tienen disponibles?'),
      customerHistory: vi.fn(() => []),
    };
    const suggester = new ReplySuggester(
      { isEnabled: () => true, generateWithTools } as unknown as AiService,
      store as unknown as RelayStore,
      productsService as unknown as OdooProductsService,
    );

    const suggestion = await suggester.suggest(1, 'customer-1');
    expect(suggestion).toBe('Contamos con Disney + premium 1 perfil ($3.50) y Crunchyroll 1 perfil ($2.50).');
    expect(productsService.search).toHaveBeenCalledWith({ offset: 0 });
  });

  it('drafts a reply citing catalog products and prices when customer asks generally what products exist', async () => {
    const productsService = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        products: [
          { id: 10, name: 'Disney + premium 1 perfil', default_code: 'DIS', list_price: 3.5, taxes_id: [] },
          { id: 11, name: 'Crunchyroll 1 perfil', default_code: 'CR', list_price: 2.5, taxes_id: [] },
        ],
        total: 2,
        offset: 0,
      }),
    };
    const generateWithTools = vi.fn(async (request: ToolLoopRequest) => {
      expect(request.system).toContain(
        'When the customer asks generally what products exist (e.g. "qué productos tiene", "qué vende"), call search_odoo_products without query to see available active products and present them.',
      );
      expect(request.system).toContain(
        'When search_odoo_products returns matching products, name them in the draft (at most five). If the customer asked for prices, you may state the price from list_price. Never invent prices or discounts not returned by Odoo.',
      );

      const toolResult = await lookup(request, { offset: 0 });
      expect(toolResult).toEqual({
        status: 'ok',
        products: [
          { id: 10, name: 'Disney + premium 1 perfil', default_code: 'DIS', list_price: 3.5, taxes_id: [] },
          { id: 11, name: 'Crunchyroll 1 perfil', default_code: 'CR', list_price: 2.5, taxes_id: [] },
        ],
        total: 2,
        offset: 0,
      });

      return {
        ok: true,
        text: 'Hola! Tenemos disponibles Disney + premium 1 perfil a $3.50 y Crunchyroll 1 perfil a $2.50.',
        toolsExecuted: ['search_odoo_products'],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });

    const store = {
      getQuestion: vi.fn(() => 'Hola, ¿qué productos tiene y cuáles son los precios?'),
      customerHistory: vi.fn(() => []),
    };
    const suggester = new ReplySuggester(
      { isEnabled: () => true, generateWithTools } as unknown as AiService,
      store as unknown as RelayStore,
      productsService as unknown as OdooProductsService,
    );

    const reply = await suggester.suggest(42, 'wa-customer-99');
    expect(reply).toBe('Hola! Tenemos disponibles Disney + premium 1 perfil a $3.50 y Crunchyroll 1 perfil a $2.50.');
    expect(productsService.search).toHaveBeenCalledWith({ offset: 0 });
    expect(generateWithTools).toHaveBeenCalledOnce();
  });

  it('guides category inquiries to fallback to active catalog when specific search yields zero matches', async () => {
    const productsService = {
      search: vi.fn().mockImplementation(async (params?: { query?: string; offset?: number }) => {
        if (params?.query === 'streaming') {
          return { status: 'ok', products: [], total: 0, offset: 0 };
        }
        return {
          status: 'ok',
          products: [
            { id: 1, name: 'Disney + premium 1 perfil', default_code: 'DIS', list_price: 3.5, taxes_id: [] },
          ],
          total: 1,
          offset: 0,
        };
      }),
    };

    const generateWithTools = vi.fn(async (request: ToolLoopRequest) => {
      expect(request.system).toContain(
        'When the customer asks about a category or service (e.g. "streaming", "cuentas", "perfiles", "películas", "series"), search for the terms. If a specific search yields 0 matches, call search_odoo_products without query to inspect the active catalog products and identify matching offerings (e.g. Disney+, Crunchyroll).',
      );
      const specific = await lookup(request, { query: 'streaming' });
      expect(specific).toEqual({ status: 'ok', products: [], total: 0, offset: 0 });
      const open = await lookup(request, { offset: 0 });
      expect(open).toEqual({
        status: 'ok',
        products: [
          { id: 1, name: 'Disney + premium 1 perfil', default_code: 'DIS', list_price: 3.5, taxes_id: [] },
        ],
        total: 1,
        offset: 0,
      });
      return {
        ok: true,
        text: 'Para streaming tenemos Disney + premium 1 perfil a $3.50.',
        toolsExecuted: ['search_odoo_products', 'search_odoo_products'],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });

    const store = {
      getQuestion: vi.fn(() => '¿Tienen cuentas de streaming?'),
      customerHistory: vi.fn(() => []),
    };
    const suggester = new ReplySuggester(
      { isEnabled: () => true, generateWithTools } as unknown as AiService,
      store as unknown as RelayStore,
      productsService as unknown as OdooProductsService,
    );

    const reply = await suggester.suggest(43, 'wa-customer-100');
    expect(reply).toBe('Para streaming tenemos Disney + premium 1 perfil a $3.50.');
    expect(productsService.search).toHaveBeenNthCalledWith(1, { query: 'streaming' });
    expect(productsService.search).toHaveBeenNthCalledWith(2, { offset: 0 });
  });
});
