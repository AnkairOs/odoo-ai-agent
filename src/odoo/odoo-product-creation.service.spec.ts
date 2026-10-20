import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationProductSchema, OdooProductCreationService, taxedTotal, untaxedPrice } from './odoo-product-creation.service.js';

export const creationConfig = {
  ODOO_PRODUCT_CREATION_ENABLED: 'true',
  ODOO_PRODUCT_COMPANY_ID: '1',
  ODOO_DEFAULT_URL: 'https://odoo.invalid',
  ODOO_DEFAULT_DB: 'test',
  ODOO_DEFAULT_API_KEY: 'fake-key',
};

function setup(values: Record<string, unknown> = creationConfig) {
  const service = new OdooProductCreationService(new ConfigService(values));
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return { service, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded product mutation', () => {
  it('sends only the fixed Odoo 19 goods payload and accepts exactly one ID', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('[42]'));
    expect(await service.create({ name: 'Pioneer  DDJ', reference: 'DDJ-1' }, service.destination()!))
      .toEqual({ status: 'created', id: 42 });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://odoo.invalid/json/2/product.product/create', {
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Authorization: 'Bearer fake-key', 'X-Odoo-Database': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ vals_list: [{ name: 'Pioneer  DDJ', default_code: 'DDJ-1', type: 'consu', is_storable: false, company_id: 1 }] }),
    });
  });

  it('omits an absent reference, never inventing commercial fields', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('[1]'));
    await service.create({ name: 'Pioneer' }, service.destination()!);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ vals_list: [
      { name: 'Pioneer', type: 'consu', is_storable: false, company_id: 1 },
    ] });
  });

  it('adds price, cost and one replacing tax command only when provided', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('[2]'));
    await service.create({ name: 'Pioneer', listPrice: 39.13, standardPrice: 30, taxId: 1 }, service.destination()!);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ vals_list: [{ name: 'Pioneer', type: 'consu',
      is_storable: false, company_id: 1, list_price: 39.13, standard_price: 30, taxes_id: [[6, 0, [1]]] }] });
    await service.create({ name: 'Pioneer', standardPrice: 0 }, service.destination()!);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ vals_list: [{ name: 'Pioneer', type: 'consu',
      is_storable: false, company_id: 1, standard_price: 0 }] });
  });

  it.each(Object.keys(creationConfig))('requires explicit %s before fetching', async (key) => {
    const { service, fetchMock } = setup({ ...creationConfig, [key]: '' });
    expect(service.destination()).toBeUndefined();
    expect(await service.create({ name: 'Pioneer' }, { url: creationConfig.ODOO_DEFAULT_URL, db: 'test', companyId: 1 }))
      .toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '1x', 'Infinity'])('rejects company %s', (company) => {
    expect(setup({ ...creationConfig, ODOO_PRODUCT_COMPANY_ID: company }).service.destination()).toBeUndefined();
  });

  it.each([
    { name: '' }, { name: 'a'.repeat(121) }, { name: 'X', reference: 'r'.repeat(256) },
    { name: 'X', price: 5 }, { name: 'https://bad.invalid' }, { name: 'X', listPrice: 0 }, { name: 'X', listPrice: 1.234 },
    { name: 'X', standardPrice: -1 }, { name: 'X', listPrice: 1_000_000.01 }, { name: 'X', taxId: 1.5 }, { name: 'X', taxes_id: [1] },
  ])('rejects invalid mutation input without fetching: %j', async (input) => {
    const { service, fetchMock } = setup();
    expect(await service.create(input, service.destination()!)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['url', 'db', 'companyId'] as const)('cannot retarget a preview when %s changes', async (field) => {
    const { service, fetchMock } = setup();
    const target = { ...service.destination()!, [field]: field === 'companyId' ? 2 : 'changed' };
    expect(await service.create({ name: 'Pioneer' }, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['42', '[]', '[0]', '[-1]', '[1,2]', '[1.2]', '[9007199254740992]', '{}', 'invalid'])('treats malformed success %s as unknown', async (body) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response(body));
    expect(await service.create({ name: 'Pioneer' }, service.destination()!)).toEqual({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 408, 429, 500, 502])('does not retry ambiguous HTTP %i', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status }));
    expect(await service.create({ name: 'Pioneer' }, service.destination()!)).toEqual({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('reports definite HTTP %i rejection', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status }));
    expect(await service.create({ name: 'Pioneer' }, service.destination()!)).toEqual({ status: 'rejected' });
  });

  it('bounds stalled transport and treats network failure as unknown', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = service.create({ name: 'Pioneer' }, service.destination()!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: 'unknown' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await service.create({ name: 'Pioneer' }, service.destination()!)).toEqual({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('server-side VAT arithmetic', () => {
  it.each([
    [45, true, 15, 39.13, 45], [45, false, 15, 45, 51.75], [39.13, false, 15, 39.13, 45],
    [10, true, 0, 10, 10], [10, false, 0, 10, 10], [0.01, true, 15, 0.01, 0.01], [1_000_000, true, 15, 869565.22, 1_000_000],
  ])('price %s (includes VAT: %s) at %s%% stores base %s and shows total %s', (price, includes, percent, base, total) => {
    expect(untaxedPrice(price, includes, percent)).toBe(base);
    expect(taxedTotal(base, percent)).toBe(total);
  });
});

describe('conversation product request', () => {
  it.each([
    { name: 'X', salePrice: 45, priceIncludesTax: true },
    { name: 'X', reference: 'R', salePrice: 45.5, priceIncludesTax: false, taxId: 10, cost: 30 },
    { name: 'X', cost: 0 }, { name: 'X', salePrice: 1_000_000, priceIncludesTax: true, cost: 1_000_000 },
  ])('accepts %j', (input) => {
    expect(conversationProductSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    { name: 'X', salePrice: 45 }, { name: 'X', priceIncludesTax: true }, { name: 'X', taxId: 1 },
    { name: 'X', salePrice: 0, priceIncludesTax: true }, { name: 'X', salePrice: 1.234, priceIncludesTax: true },
    { name: 'X', salePrice: 1_000_000.01, priceIncludesTax: true }, { name: 'X', cost: -0.01 }, { name: 'X', cost: 0.001 },
    { name: 'X', salePrice: 45, priceIncludesTax: true, taxId: 0 }, { name: 'X', salePrice: 45, priceIncludesTax: 'yes' },
    { name: 'X', salePrice: 45, priceIncludesTax: true, list_price: 45 }, { name: 'X', companyId: 2 },
  ])('rejects %j', (input) => {
    expect(conversationProductSchema.safeParse(input).success).toBe(false);
  });
});
