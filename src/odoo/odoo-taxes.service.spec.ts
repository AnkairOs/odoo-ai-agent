import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OdooClientService } from './odoo-client.service.js';
import { OdooTaxesService } from './odoo-taxes.service.js';

const target = { url: 'https://odoo.invalid', db: 'test', companyId: 1 };
const taxes = [
  { id: 1, name: 'VAT 15% G', amount: 15, price_include: false },
  { id: 10, name: 'VAT 0% G', amount: 0, price_include: false },
  { id: 30, name: 'Included', amount: 15, price_include: true },
];

function setup(apiKey = 'fake-key') {
  const config = new ConfigService({ ODOO_DEFAULT_API_KEY: apiKey });
  const service = new OdooTaxesService(new OdooClientService(config), config);
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return { service, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe('read-only sale tax lookup', () => {
  it('lists active percent sale taxes of the fixed company with a fixed bounded query', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(taxes)));
    expect(await service.listSaleTaxes(target)).toEqual({ status: 'ok', taxes: [
      { id: 1, name: 'VAT 15% G', percent: 15 }, { id: 10, name: 'VAT 0% G', percent: 0 },
    ] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://odoo.invalid/json/2/account.tax/search_read');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer fake-key', 'X-Odoo-Database': 'test' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      domain: [['active', '=', true], ['type_tax_use', '=', 'sale'], ['amount_type', '=', 'percent'], ['company_id', '=', 1]],
      fields: ['id', 'name', 'amount', 'price_include'], limit: 50,
    });
  });

  it.each(['{}', '[{"id":"1","name":"x","amount":15,"price_include":false}]', 'invalid'])('treats malformed response %s as unavailable', async (body) => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response(body));
    expect(await service.listSaleTaxes(target)).toEqual({ status: 'unavailable' });
  });

  it('treats HTTP and network failures as unavailable and requires an explicit credential', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response('private traceback', { status: 500 }));
    expect(await service.listSaleTaxes(target)).toEqual({ status: 'unavailable' });
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await service.defaultSaleTaxId(target)).toEqual({ status: 'unavailable' });
    const blank = setup(' ');
    expect(await blank.service.listSaleTaxes(target)).toEqual({ status: 'unavailable' });
    expect(await blank.service.defaultSaleTaxId(target)).toEqual({ status: 'unavailable' });
    expect(blank.fetchMock).not.toHaveBeenCalled();
  });

  it('reads only the fixed company default sale tax', async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response('[{"id":1,"account_sale_tax_id":[1,"VAT 15% G"]}]'));
    expect(await service.defaultSaleTaxId(target)).toEqual({ status: 'ok', taxId: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://odoo.invalid/json/2/res.company/read');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ ids: [1], fields: ['account_sale_tax_id'] });
    fetchMock.mockResolvedValueOnce(new Response('[{"id":1,"account_sale_tax_id":false}]'));
    expect(await service.defaultSaleTaxId(target)).toEqual({ status: 'ok', taxId: null });
    fetchMock.mockResolvedValueOnce(new Response('[{"id":2,"account_sale_tax_id":[1,"VAT 15% G"]}]'));
    expect(await service.defaultSaleTaxId(target)).toEqual({ status: 'unavailable' });
  });
});
