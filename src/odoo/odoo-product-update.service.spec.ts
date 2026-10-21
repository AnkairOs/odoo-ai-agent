import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchArchiveIdsSchema,
  batchProductUpdateSchema,
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

describe('archiveBatch', () => {
  it('archives multiple products with active: false via single JSON-2 write', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('true'));
    const target = service.destination()!;

    const result = await service.archiveBatch([10, 20, 30], target);

    expect(result).toEqual({ status: 'archived', ids: [10, 20, 30] });
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
        ids: [10, 20, 30],
        vals: { active: false },
      }),
    });
  });

  it('rejects batches with fewer than 2 or more than 50 IDs without fetching', async () => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(await service.archiveBatch([], target)).toEqual({ status: 'unavailable' });
    expect(await service.archiveBatch([42], target)).toEqual({ status: 'unavailable' });

    const fiftyOne = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(await service.archiveBatch(fiftyOne, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate IDs in archive batch without fetching', async () => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(await service.archiveBatch([10, 10], target)).toEqual({ status: 'unavailable' });
    expect(await service.archiveBatch([10, 20, 10], target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid ID %j within archive batch', async (invalidId) => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(await service.archiveBatch([10, invalidId], target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['url', 'db', 'companyId'] as const)('rejects mismatched destination %s', async (field) => {
    const { service, fetchMock } = setup();
    const target = { ...service.destination()!, [field]: field === 'companyId' ? 99 : 'changed' };

    expect(await service.archiveBatch([10, 20], target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('reports definite HTTP %i rejection for batch archive', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status }));
    const target = service.destination()!;

    expect(await service.archiveBatch([10, 20], target)).toEqual({ status: 'rejected' });
  });

  it.each([400, 408, 429, 500, 502, 503])(
    'treats ambiguous HTTP %i as unknown with no mutation retry',
    async (status) => {
      const { service, fetchMock } = setup();
      fetchMock.mockResolvedValue(new Response('', { status }));
      const target = service.destination()!;

      expect(await service.archiveBatch([10, 20], target)).toEqual({ status: 'unknown' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['false', 'null', '[]', '[1]', '{"id": 42}', '""', 'random string'])(
    'treats non-true response %s as unknown',
    async (body) => {
      const { service, fetchMock } = setup();
      fetchMock.mockResolvedValue(new Response(body));
      const target = service.destination()!;

      expect(await service.archiveBatch([10, 20], target)).toEqual({ status: 'unknown' });
    },
  );

  it('bounds stalled transport at 15s and treats network failure as unknown', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const target = service.destination()!;

    const pending = service.archiveBatch([10, 20], target);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'unknown' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);

    fetchMock.mockRejectedValue(new Error('Network batch error'));
    expect(await service.archiveBatch([10, 20], target)).toEqual({ status: 'unknown' });
  });
});

describe('updateBatch', () => {
  it.each([401, 403, 404])('retains committed IDs when a later write returns HTTP %i', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response('true'))
      .mockResolvedValueOnce(new Response('', { status }));

    expect(await service.updateBatch([
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { name: 'B' } },
      { id: 3, input: { name: 'C' } },
    ], service.destination()!)).toEqual({
      status: 'partial', updatedIds: [1], rejectedIds: [2], unknownIds: [], notAttemptedIds: [3],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 408, 429, 500, 502, 503])(
    'retains committed IDs when first group succeeds and second group returns ambiguous HTTP %i',
    async (status) => {
      const { service, fetchMock } = setup();
      fetchMock
        .mockResolvedValueOnce(new Response('true'))
        .mockResolvedValueOnce(new Response('', { status }));

      expect(
        await service.updateBatch(
          [
            { id: 1, input: { name: 'A' } },
            { id: 2, input: { name: 'B' } },
            { id: 3, input: { name: 'C' } },
          ],
          service.destination()!,
        ),
      ).toEqual({
        status: 'partial',
        updatedIds: [1],
        rejectedIds: [],
        unknownIds: [2],
        notAttemptedIds: [3],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('retains committed IDs when first group succeeds and second group encounters network error', async () => {
    const { service, fetchMock } = setup();
    fetchMock
      .mockResolvedValueOnce(new Response('true'))
      .mockRejectedValueOnce(new Error('Network error on second group'));

    expect(
      await service.updateBatch(
        [
          { id: 1, input: { name: 'A' } },
          { id: 2, input: { name: 'B' } },
          { id: 3, input: { name: 'C' } },
        ],
        service.destination()!,
      ),
    ).toEqual({
      status: 'partial',
      updatedIds: [1],
      rejectedIds: [],
      unknownIds: [2],
      notAttemptedIds: [3],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains multiple committed IDs within a shared group when later group fails', async () => {
    const { service, fetchMock } = setup();
    fetchMock
      .mockResolvedValueOnce(new Response('true'))
      .mockResolvedValueOnce(new Response('', { status: 403 }));

    expect(
      await service.updateBatch(
        [
          { id: 10, input: { listPrice: 50.0 } },
          { id: 20, input: { listPrice: 50.0 } },
          { id: 30, input: { name: 'Different' } },
          { id: 40, input: { name: 'Another' } },
        ],
        service.destination()!,
      ),
    ).toEqual({
      status: 'partial',
      updatedIds: [10, 20],
      rejectedIds: [30],
      unknownIds: [],
      notAttemptedIds: [40],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never dispatches remaining groups after a timed-out transport ignores abort', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    let finishFirst: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; }))
      .mockImplementation(() => Promise.resolve(new Response('true')));
    const pending = service.updateBatch([
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { name: 'B' } },
    ], service.destination()!);

    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    finishFirst!(new Response('true'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'unknown', updatedIds: [], rejectedIds: [], unknownIds: [1], notAttemptedIds: [2],
    });
  });

  it('does not dispatch subsequent groups when timeout occurs during a later group write', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    let finishSecond: ((response: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(new Response('true'))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishSecond = resolve; }))
      .mockImplementation(() => Promise.resolve(new Response('true')));

    const pending = service.updateBatch(
      [
        { id: 1, input: { name: 'A' } },
        { id: 2, input: { name: 'B' } },
        { id: 3, input: { name: 'C' } },
      ],
      service.destination()!,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(result).toEqual({
      status: 'partial',
      updatedIds: [1],
      rejectedIds: [],
      unknownIds: [2],
      notAttemptedIds: [3],
    });
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);

    finishSecond!(new Response('true'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('checks signal.aborted before each group and skips execution when already aborted', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    let finishFirst: ((response: Response) => void) | undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; }))
      .mockImplementation(() => Promise.resolve(new Response('true')));

    const pending = service.updateBatch(
      [
        { id: 1, input: { name: 'A' } },
        { id: 2, input: { name: 'B' } },
        { id: 3, input: { name: 'C' } },
      ],
      service.destination()!,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(result).toEqual({
      status: 'unknown',
      updatedIds: [],
      rejectedIds: [],
      unknownIds: [1],
      notAttemptedIds: [2, 3],
    });

    finishFirst!(new Response('true'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updates multiple products via JSON-2 write calls', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockImplementation(() => Promise.resolve(new Response('true')));
    const target = service.destination()!;

    const items = [
      { id: 10, input: { name: 'Prod A', listPrice: 20.0 } },
      { id: 20, input: { name: 'Prod B', reference: 'REF-B' } },
    ];
    const result = await service.updateBatch(items, target);

    expect(result).toEqual({ status: 'updated', count: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      ids: [10],
      vals: { name: 'Prod A', list_price: 20.0 },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      ids: [20],
      vals: { name: 'Prod B', default_code: 'REF-B' },
    });
  });

  it('groups writes when multiple items share identical vals', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('true'));
    const target = service.destination()!;

    const items = [
      { id: 10, input: { standardPrice: 15.0 } },
      { id: 20, input: { standardPrice: 15.0 } },
    ];
    const result = await service.updateBatch(items, target);

    expect(result).toEqual({ status: 'updated', count: 2 });
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
        ids: [10, 20],
        vals: { standard_price: 15.0 },
      }),
    });
  });

  it('reports all grouped IDs when a shared-val write fails', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));
    const target = service.destination()!;
    const items = [
      { id: 10, input: { standardPrice: 15.0 } },
      { id: 20, input: { standardPrice: 15.0 } },
    ];

    expect(await service.updateBatch(items, target)).toEqual({
      status: 'rejected',
      updatedIds: [],
      rejectedIds: [10, 20],
      unknownIds: [],
      notAttemptedIds: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects batches with fewer than 2 or more than 20 items without fetching', async () => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(await service.updateBatch([], target)).toEqual({ status: 'unavailable' });
    expect(await service.updateBatch([{ id: 1, input: { name: 'Solo' } }], target)).toEqual({
      status: 'unavailable',
    });

    const twentyOne = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      input: { name: `Prod ${i + 1}` },
    }));
    expect(await service.updateBatch(twentyOne, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate IDs in update batch without fetching', async () => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    const duplicates = [
      { id: 10, input: { name: 'Name 1' } },
      { id: 10, input: { name: 'Name 2' } },
    ];
    expect(await service.updateBatch(duplicates, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid product ID or invalid input in items without fetching', async () => {
    const { service, fetchMock } = setup();
    const target = service.destination()!;

    expect(
      await service.updateBatch(
        [
          { id: 0, input: { name: 'Bad ID' } },
          { id: 2, input: { name: 'Valid' } },
        ],
        target,
      ),
    ).toEqual({ status: 'unavailable' });

    expect(
      await service.updateBatch(
        [
          { id: 1, input: {} as ProductUpdate },
          { id: 2, input: { name: 'Valid' } },
        ],
        target,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['url', 'db', 'companyId'] as const)('rejects mismatched destination %s', async (field) => {
    const { service, fetchMock } = setup();
    const target = { ...service.destination()!, [field]: field === 'companyId' ? 99 : 'changed' };
    const items = [
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { name: 'B' } },
    ];

    expect(await service.updateBatch(items, target)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('reports definite HTTP %i rejection for batch update', async (status) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('', { status }));
    const target = service.destination()!;
    const items = [
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { name: 'B' } },
    ];

    expect(await service.updateBatch(items, target)).toEqual({
      status: 'rejected',
      updatedIds: [],
      rejectedIds: [1],
      unknownIds: [],
      notAttemptedIds: [2],
    });
  });

  it.each([400, 408, 429, 500, 502, 503])(
    'treats ambiguous HTTP %i as unknown with no mutation retry',
    async (status) => {
      const { service, fetchMock } = setup();
      fetchMock.mockResolvedValue(new Response('', { status }));
      const target = service.destination()!;
      const items = [
        { id: 1, input: { name: 'A' } },
        { id: 2, input: { name: 'B' } },
      ];

      expect(await service.updateBatch(items, target)).toEqual({
        status: 'unknown',
        updatedIds: [],
        rejectedIds: [],
        unknownIds: [1],
        notAttemptedIds: [2],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('stops subsequent writes if an earlier write is rejected', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
    const target = service.destination()!;
    const items = [
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { name: 'B' } },
    ];

    expect(await service.updateBatch(items, target)).toEqual({
      status: 'rejected',
      updatedIds: [],
      rejectedIds: [1],
      unknownIds: [],
      notAttemptedIds: [2],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled transport at 15s and treats network failure as unknown', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = setup();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const target = service.destination()!;
    const items = [
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { name: 'B' } },
    ];

    const pending = service.updateBatch(items, target);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      status: 'unknown',
      updatedIds: [],
      rejectedIds: [],
      unknownIds: [1],
      notAttemptedIds: [2],
    });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);

    fetchMock.mockRejectedValue(new Error('Network batch error'));
    expect(await service.updateBatch(items, target)).toEqual({
      status: 'unknown',
      updatedIds: [],
      rejectedIds: [],
      unknownIds: [1],
      notAttemptedIds: [2],
    });
  });
});

describe('batchArchiveIdsSchema', () => {
  it('accepts between 2 and 50 unique positive safe integers', () => {
    expect(batchArchiveIdsSchema.safeParse([1, 2]).success).toBe(true);
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(batchArchiveIdsSchema.safeParse(fifty).success).toBe(true);
  });

  it('rejects fewer than 2, more than 50, or duplicates', () => {
    expect(batchArchiveIdsSchema.safeParse([]).success).toBe(false);
    expect(batchArchiveIdsSchema.safeParse([1]).success).toBe(false);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(batchArchiveIdsSchema.safeParse(fiftyOne).success).toBe(false);
    expect(batchArchiveIdsSchema.safeParse([1, 1]).success).toBe(false);
    expect(batchArchiveIdsSchema.safeParse([1, 2, 1]).success).toBe(false);
  });
});

describe('batchProductUpdateSchema', () => {
  it('accepts between 2 and 20 unique valid items', () => {
    const items = [
      { id: 1, input: { name: 'A' } },
      { id: 2, input: { listPrice: 10 } },
    ];
    expect(batchProductUpdateSchema.safeParse(items).success).toBe(true);
  });

  it('rejects fewer than 2, more than 20, or duplicate IDs', () => {
    expect(batchProductUpdateSchema.safeParse([]).success).toBe(false);
    expect(batchProductUpdateSchema.safeParse([{ id: 1, input: { name: 'A' } }]).success).toBe(false);

    const twentyOne = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      input: { name: `A${i}` },
    }));
    expect(batchProductUpdateSchema.safeParse(twentyOne).success).toBe(false);

    const duplicates = [
      { id: 1, input: { name: 'A' } },
      { id: 1, input: { name: 'B' } },
    ];
    expect(batchProductUpdateSchema.safeParse(duplicates).success).toBe(false);
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


