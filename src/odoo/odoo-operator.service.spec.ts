import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OdooClientService } from './odoo-client.service.js';
import { OdooOperatorService } from './odoo-operator.service.js';

interface TestEnv {
  ODOO_DEFAULT_URL?: string;
  ODOO_DEFAULT_DB?: string;
  ODOO_DEFAULT_API_KEY?: string;
  ODOO_PRODUCT_COMPANY_ID?: string | number;
  RELAY_OPERATOR_WA_ID?: string;
}

const defaultEnv: TestEnv = {
  ODOO_DEFAULT_URL: 'https://odoo.invalid',
  ODOO_DEFAULT_DB: 'test',
  ODOO_DEFAULT_API_KEY: 'fake-key',
  ODOO_PRODUCT_COMPANY_ID: '1',
  RELAY_OPERATOR_WA_ID: '593999999999',
};

function setup(overrides: Partial<TestEnv> = {}) {
  const env: Record<string, unknown> = { ...defaultEnv, ...overrides };
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) {
      delete env[key];
    }
  }
  const config = new ConfigService(env);
  const odooClient = new OdooClientService(config);
  const callModelSpy = vi.spyOn(odooClient, 'callModel');
  const service = new OdooOperatorService(config, odooClient);
  return { service, config, odooClient, callModelSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OdooOperatorService', () => {
  describe('happy path & caching', () => {
    it('reads res.company.phone = "0992849536", normalizes to "593992849536", and caches for 5 minutes', async () => {
      const { service, callModelSpy } = setup();
      callModelSpy.mockResolvedValueOnce([{ id: 1, phone: '0992849536' }]);

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledOnce();
      expect(callModelSpy).toHaveBeenCalledWith(
        {
          url: 'https://odoo.invalid',
          db: 'test',
          apiKey: 'fake-key',
        },
        'res.company',
        'read',
        {
          ids: [1],
          fields: ['id', 'phone'],
        },
      );

      const cachedPhone = await service.resolveOperatorPhone();
      expect(cachedPhone).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledOnce();
    });

    it('re-queries Odoo after 5-minute cache TTL expires', async () => {
      vi.useFakeTimers();
      const { service, callModelSpy } = setup();
      callModelSpy.mockResolvedValue([{ id: 1, phone: '0992849536' }]);

      expect(await service.resolveOperatorPhone()).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(299_999);
      expect(await service.resolveOperatorPhone()).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(await service.resolveOperatorPhone()).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledTimes(2);
    });

    it('re-queries Odoo immediately after clearCache()', async () => {
      const { service, callModelSpy } = setup();
      callModelSpy.mockResolvedValue([{ id: 1, phone: '0992849536' }]);

      expect(await service.resolveOperatorPhone()).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledTimes(1);

      service.clearCache();

      expect(await service.resolveOperatorPhone()).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('phone normalization', () => {
    it.each([
      ['+593 99 284 9536', '593992849536'],
      ['0992849536', '593992849536'],
      ['593992849536', '593992849536'],
      ['992849536', '593992849536'],
      ['+593-99-284-9536', '593992849536'],
      ['+1 415 555 2671', '14155552671'],
      ['+593 2 234 5678', '59322345678'],
    ])('normalizes %s to %s', async (inputPhone, expected) => {
      const { service, callModelSpy } = setup();
      callModelSpy.mockResolvedValueOnce([{ id: 1, phone: inputPhone }]);

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe(expected);
    });
  });

  describe('fallback when Odoo returns empty or invalid phone', () => {
    it.each([
      ['empty string', ''],
      ['whitespace string', '   '],
      ['boolean false', false],
      ['null', null],
      ['invalid short digits', '123'],
      ['letters only', 'not-a-number'],
    ])('falls back to RELAY_OPERATOR_WA_ID when phone is %s', async (_, odooPhone) => {
      const { service, callModelSpy } = setup({ RELAY_OPERATOR_WA_ID: '593999999999' });
      callModelSpy.mockResolvedValueOnce([{ id: 1, phone: odooPhone }]);

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe('593999999999');
    });

    it('falls back to RELAY_OPERATOR_WA_ID when Odoo returns an empty array', async () => {
      const { service, callModelSpy } = setup({ RELAY_OPERATOR_WA_ID: '593999999999' });
      callModelSpy.mockResolvedValueOnce([]);

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe('593999999999');
    });

    it('returns undefined if fallback RELAY_OPERATOR_WA_ID is also not configured', async () => {
      const { service, callModelSpy } = setup({ RELAY_OPERATOR_WA_ID: undefined });
      callModelSpy.mockResolvedValueOnce([{ id: 1, phone: false }]);

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBeUndefined();
    });
  });

  describe('fallback when Odoo query throws or times out', () => {
    it('falls back to RELAY_OPERATOR_WA_ID on HTTP 500 or network error', async () => {
      const { service, callModelSpy } = setup({ RELAY_OPERATOR_WA_ID: '593999999999' });
      callModelSpy.mockRejectedValueOnce(new Error('Internal Server Error 500'));

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe('593999999999');
    });

    it('caches error fallback for 60 seconds then retries Odoo', async () => {
      vi.useFakeTimers();
      const { service, callModelSpy } = setup({ RELAY_OPERATOR_WA_ID: '593999999999' });
      callModelSpy.mockRejectedValueOnce(new Error('Network error'));

      expect(await service.resolveOperatorPhone()).toBe('593999999999');
      expect(callModelSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(await service.resolveOperatorPhone()).toBe('593999999999');
      expect(callModelSpy).toHaveBeenCalledTimes(1);

      callModelSpy.mockResolvedValueOnce([{ id: 1, phone: '0992849536' }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await service.resolveOperatorPhone()).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledTimes(2);
    });

    it('falls back to RELAY_OPERATOR_WA_ID when Odoo query times out after 5 seconds', async () => {
      vi.useFakeTimers();
      const { service, callModelSpy } = setup({ RELAY_OPERATOR_WA_ID: '593999999999' });
      callModelSpy.mockImplementation(() => new Promise(() => {}));

      const pending = service.resolveOperatorPhone();
      await vi.advanceTimersByTimeAsync(5_000);
      const phone = await pending;

      expect(phone).toBe('593999999999');
    });
  });

  describe('fallback when Odoo config is missing or disabled', () => {
    it.each([
      ['ODOO_DEFAULT_URL', { ODOO_DEFAULT_URL: undefined }],
      ['empty ODOO_DEFAULT_URL', { ODOO_DEFAULT_URL: '   ' }],
      ['invalid protocol in ODOO_DEFAULT_URL', { ODOO_DEFAULT_URL: 'ftp://odoo.invalid' }],
      ['ODOO_DEFAULT_DB', { ODOO_DEFAULT_DB: undefined }],
      ['empty ODOO_DEFAULT_DB', { ODOO_DEFAULT_DB: '' }],
      ['ODOO_DEFAULT_API_KEY', { ODOO_DEFAULT_API_KEY: undefined }],
      ['empty ODOO_DEFAULT_API_KEY', { ODOO_DEFAULT_API_KEY: '  ' }],
      ['ODOO_PRODUCT_COMPANY_ID', { ODOO_PRODUCT_COMPANY_ID: undefined }],
      ['invalid company ID "0"', { ODOO_PRODUCT_COMPANY_ID: '0' }],
      ['invalid company ID "-1"', { ODOO_PRODUCT_COMPANY_ID: '-1' }],
      ['invalid company ID "abc"', { ODOO_PRODUCT_COMPANY_ID: 'abc' }],
    ])('falls back without querying Odoo when %s is invalid', async (_, overrides) => {
      const { service, callModelSpy } = setup({
        ...overrides,
        RELAY_OPERATOR_WA_ID: '593999999999',
      });

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe('593999999999');
      expect(callModelSpy).not.toHaveBeenCalled();
    });

    it('accepts ODOO_PRODUCT_COMPANY_ID as a safe integer number', async () => {
      const { service, callModelSpy } = setup({ ODOO_PRODUCT_COMPANY_ID: 1 });
      callModelSpy.mockResolvedValueOnce([{ id: 1, phone: '0992849536' }]);

      const phone = await service.resolveOperatorPhone();
      expect(phone).toBe('593992849536');
      expect(callModelSpy).toHaveBeenCalledOnce();
    });
  });
});
