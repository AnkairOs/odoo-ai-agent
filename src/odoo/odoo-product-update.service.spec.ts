import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OdooProductUpdateService,
  productUpdateSchema,
  type ProductUpdate,
} from './odoo-product-update.service.js';

const baseConfig = {
  ODOO_PRODUCT_CREATION_ENABLED: 'true',
  ODOO_PRODUCT_COMPANY_ID: '1',
  ODOO_DEFAULT_URL: 'https://odoo.invalid',
  ODOO_DEFAULT_DB: 'test',
  ODOO_DEFAULT_API_KEY: 'fake-key',
};

function setup(values: Record<string, unknown> = baseConfig) {
  const service = new OdooProductUpdateService(new ConfigService(values));
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return { service, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OdooProductUpdateService', () => {
  it('updates product fields with JSON-2 write', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('true'));

    const target = service.destination()!;
    const result = await service.update(42, { name: 'Updated Widget', listPrice: 19.99 }, target);

    expect(result).toEqual({ status: 'updated' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://odoo.invalid/json/2/product.product/write', {
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: {
        Authorization: 'Bearer fake-key',
        'X-Odoo-Database': 'test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: [42],
        vals: {
          name: 'Updated Widget',
          list_price: 19.99,
        },
      }),
    });
  });

  it('maps all supported update fields including reference, standardPrice, and taxes_id', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('true'));

    const target = service.destination()!;
    const result = await service.update(
      15,
      {
        name: 'Pro Cable',
        reference: 'CBL-99',
        listPrice: 50.0,
        standardPrice: 20.0,
        taxId: 7,
      },
      target,
    );

    expect(result).toEqual({ status: 'updated' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      ids: [15],
      vals: {
        name: 'Pro Cable',
        default_code: 'CBL-99',
        list_price: 50.0,
        standard_price: 20.0,
        taxes_id: [[6, 0, [7]]],
      },
    });
  });

  it('archives product with active: false via JSON-2 write', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('true'));

    const target = service.destination()!;
    const result = await service.archive(42, target);

    expect(result).toEqual({ status: 'archived' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://odoo.invalid/json/2/product.product/write', {
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: {
        Authorization: 'Bearer fake-key',
        'X-Odoo-Database': 'test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: [42],
        vals: { active: false },
      }),
    });
  });

  it.each(Object.keys(baseConfig))('requires explicit %s for destination', (key) => {
    const { service } = setup({ ...baseConfig, [key]: '' });
    expect(service.destination()).toBeUndefined();
  });

  it.each(['0', '-1', '1.5', '1x', 'Infinity', '-5'])('rejects company %s', (company) => {
    expect(setup({ ...baseConfig, ODOO_PRODUCT_COMPANY_ID: company }).service.destination()).toBeUndefined();
  });

  it.each([
    'not-a-url',
    'ftp://odoo.invalid',
    'https://user:pass@odoo.invalid',
    'https://odoo.invalid?query=1',
    'https://odoo.invalid#hash',
  ])('rejects invalid or unsafe URL %s', (url) => {
    expect(setup({ ...baseConfig, ODOO_DEFAULT_URL: url }).service.destination()).toBeUndefined();
  });

  it.each(['url', 'db', 'companyId'] as const)('rejects mismatched destination %s', async (field) => {
    const { service, fetchMock } = setup();
    const target = { ...service.destination()!, [field]: field === 'companyId' ? 99 : 'changed' };

    expect(await service.update(42, { name: 'Widget' }, target)).toEqual({ status: 'unavailable' });
    expect(await service.archive(42, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('rejects invalid product ID %j without fetching', async (id) => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(await service.update(id, { name: 'Widget' }, target)).toEqual({ status: 'unavailable' });
    expect(await service.archive(id, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { otherField: 'val' },
    { name: '' },
    { name: '   ' },
    { name: 'a'.repeat(121) },
    { reference: 'r'.repeat(256) },
    { listPrice: 0 },
    { listPrice: -1 },
    { listPrice: 1.234 },
    { listPrice: 1_000_000.01 },
    { standardPrice: -0.01 },
    { standardPrice: 1.234 },
    { standardPrice: 1_000_000.01 },
    { taxId: 0 },
    { taxId: -1 },
    { taxId: 1.5 },
  ])('rejects invalid update input %j without fetching', async (input) => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(await service.update(42, input as unknown as ProductUpdate, target)).toEqual({
      status: 'unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('reports definite HTTP %i rejection for update and archive', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status }));
    const target = service.destination()!;

    expect(await service.update(42, { name: 'Widget' }, target)).toEqual({ status: 'rejected' });
    expect(await service.archive(42, target)).toEqual({ status: 'rejected' });
  });

  it.each([400, 408, 429, 500, 502, 503])('treats ambiguous HTTP %i as unknown with no mutation retry', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status }));
    const target = service.destination()!;

    expect(await service.update(42, { name: 'Widget' }, target)).toEqual({ status: 'unknown' });
    expect(await service.archive(42, target)).toEqual({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['false', 'null', '[]', '[1]', '{"id": 42}', '""', 'random string'])(
    'treats non-true response %s as unknown',
    async (body) => {
      const { service, fetchMock } = setup();
      fetchMock.mockResolvedValue(new Response(body));
      const target = service.destination()!;

      expect(await service.update(42, { name: 'Widget' }, target)).toEqual({ status: 'unknown' });
      expect(await service.archive(42, target)).toEqual({ status: 'unknown' });
    },
  );

  it('bounds stalled transport at 10s and treats network failure as unknown', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const target = service.destination()!;

    const pendingUpdate = service.update(42, { name: 'Widget' }, target);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pendingUpdate).toEqual({ status: 'unknown' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);

    fetchMock.mockRejectedValue(new Error('Network disconnected'));
    expect(await service.update(42, { name: 'Widget' }, target)).toEqual({ status: 'unknown' });
    expect(await service.archive(42, target)).toEqual({ status: 'unknown' });
  });
});

describe('productUpdateSchema', () => {
  it.each([
    { name: 'Lamp' },
    { reference: 'LMP-1' },
    { listPrice: 20.5 },
    { standardPrice: 10.0 },
    { taxId: 1 },
    { name: 'Lamp', listPrice: 25.0, standardPrice: 12.5, taxId: 2, reference: 'REF' },
  ])('accepts valid update shape %j', (input) => {
    expect(productUpdateSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    {},
    { unknownField: 'test' },
    { name: 'Lamp', extra: 123 },
    { name: '' },
    { reference: '' },
    { listPrice: 0 },
    { standardPrice: -1 },
    { taxId: 0 },
  ])('rejects invalid update shape %j', (input) => {
    expect(productUpdateSchema.safeParse(input).success).toBe(false);
  });
});


