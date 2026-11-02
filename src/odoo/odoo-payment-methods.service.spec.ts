import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OdooClientService } from './odoo-client.service.js';
import { OdooPaymentMethodsService } from './odoo-payment-methods.service.js';

const settings = {
  ODOO_DEFAULT_URL: 'https://odoo.example.invalid',
  ODOO_DEFAULT_DB: 'only_business',
  ODOO_DEFAULT_API_KEY: 'mock-key',
  ODOO_PRODUCT_COMPANY_ID: '1',
};

function createService(config = settings) {
  const serviceConfig = new ConfigService(config);
  return new OdooPaymentMethodsService(new OdooClientService(serviceConfig), serviceConfig);
}

describe('OdooPaymentMethodsService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('destination', () => {
    it('returns destination when configured properly', () => {
      const svc = createService();
      expect(svc.destination()).toEqual({
        url: 'https://odoo.example.invalid',
        db: 'only_business',
        companyId: 1,
      });
    });

    it('returns undefined if missing company id', () => {
      const svc = createService({ ...settings, ODOO_PRODUCT_COMPANY_ID: '' });
      expect(svc.destination()).toBeUndefined();
    });
  });

  describe('list', () => {
    it('queries res.company to resolve partner_id, then searches res.partner.bank', async () => {
      fetchMock.mockImplementation(async (url, init) => {
        const u = String(url);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

        if (u.includes('/res.company/read')) {
          return new Response(JSON.stringify([{ id: 1, partner_id: [1, 'My Company'] }]));
        }
        if (u.includes('/res.partner.bank/search_read')) {
          expect(body.domain).toEqual([
            ['active', '=', true],
            '|',
            ['partner_id', '=', 1],
            ['company_id', '=', 1],
          ]);
          return new Response(JSON.stringify([
            {
              id: 10,
              acc_number: '2200112233',
              acc_holder_name: 'Juan Perez',
              bank_id: [3, 'Banco Pichincha'],
              note: 'Ahorros',
              active: true,
            },
          ]));
        }
        return new Response('not found', { status: 404 });
      });

      const svc = createService();
      const res = await svc.list();
      expect(res).toEqual({
        status: 'ok',
        methods: [
          {
            id: 10,
            accNumber: '2200112233',
            accHolderName: 'Juan Perez',
            bankId: 3,
            bankName: 'Banco Pichincha',
            bankBic: undefined,
            note: 'Ahorros',
            active: true,
          },
        ],
      });
    });

    it('returns status unavailable when fetch fails', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));
      const svc = createService();
      const res = await svc.list();
      expect(res.status).toBe('unavailable');
    });
  });

  describe('getById', () => {
    it('returns payment method by id', async () => {
      fetchMock.mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/res.company/read')) {
          return new Response(JSON.stringify([{ id: 1, partner_id: [1, 'My Company'] }]));
        }
        if (u.includes('/res.partner.bank/search_read')) {
          return new Response(JSON.stringify([
            {
              id: 10,
              acc_number: '2200112233',
              acc_holder_name: 'Juan Perez',
              bank_id: [3, 'Banco Pichincha'],
              note: 'Ahorros',
              active: true,
            },
          ]));
        }
        return new Response('not found', { status: 404 });
      });

      const svc = createService();
      const item = await svc.getById(10);
      expect(item).toBeDefined();
      expect(item?.accNumber).toBe('2200112233');
      expect(item?.bankName).toBe('Banco Pichincha');
    });
  });

  describe('create', () => {
    it('resolves bank, company partner and creates record in res.partner.bank', async () => {
      fetchMock.mockImplementation(async (url, init) => {
        const u = String(url);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

        if (u.includes('/res.company/read')) {
          return new Response(JSON.stringify([{ id: 1, partner_id: [1, 'My Company'] }]));
        }
        if (u.includes('/res.bank/search_read')) {
          return new Response(JSON.stringify([{ id: 7, name: 'Produbanco' }]));
        }
        if (u.includes('/res.partner.bank/create')) {
          expect(body.vals_list).toEqual([
            {
              acc_number: '1234567890',
              partner_id: 1,
              company_id: 1,
              acc_holder_name: 'Empresa SA',
              note: 'Corriente',
              bank_id: 7,
            },
          ]);
          return new Response(JSON.stringify([42]));
        }
        return new Response('not found', { status: 404 });
      });

      const svc = createService();
      const result = await svc.create({
        accNumber: '1234567890',
        accHolderName: 'Empresa SA',
        bankName: 'Produbanco',
        note: 'Corriente',
      });

      expect(result).toEqual({ status: 'created', id: 42 });
    });
  });

  describe('update', () => {
    it('calls res.partner.bank write with updated fields', async () => {
      fetchMock.mockImplementation(async (url, init) => {
        const u = String(url);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

        if (u.includes('/res.bank/search_read')) {
          return new Response(JSON.stringify([{ id: 5, name: 'Guayaquil' }]));
        }
        if (u.includes('/res.partner.bank/write')) {
          expect(body.ids).toEqual([42]);
          expect(body.vals).toEqual({
            acc_number: '9999999999',
            bank_id: 5,
          });
          return new Response(JSON.stringify(true));
        }
        return new Response('not found', { status: 404 });
      });

      const svc = createService();
      const result = await svc.update({
        id: 42,
        accNumber: '9999999999',
        bankName: 'Guayaquil',
      });

      expect(result).toEqual({ status: 'updated', id: 42 });
    });
  });

  describe('archive', () => {
    it('calls res.partner.bank write with active: false (soft delete)', async () => {
      fetchMock.mockImplementation(async (url, init) => {
        const u = String(url);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

        if (u.includes('/res.partner.bank/write')) {
          expect(body.ids).toEqual([42]);
          expect(body.vals).toEqual({ active: false });
          return new Response(JSON.stringify(true));
        }
        return new Response('not found', { status: 404 });
      });

      const svc = createService();
      const result = await svc.archive(42);

      expect(result).toEqual({ status: 'archived', id: 42 });
    });
  });
});
