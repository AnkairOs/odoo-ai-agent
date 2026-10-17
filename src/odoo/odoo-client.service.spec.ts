import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { OdooClientService } from './odoo-client.service.js';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('OdooClientService', () => {
  let service: OdooClientService;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: vi.fn((key: string, defaultValue?: string) => {
        const map: Record<string, string> = {
          ODOO_DEFAULT_URL: 'http://localhost:8069',
          ODOO_DEFAULT_DB: 'test_db',
          ODOO_DEFAULT_API_KEY: 'test_key_123',
        };
        return map[key] || defaultValue || '';
      }) as unknown as ConfigService['get'],
    };

    service = new OdooClientService(mockConfigService as ConfigService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load default configuration from environment', () => {
    const config = service.getDefaultConfig();
    expect(config.url).toBe('http://localhost:8069');
    expect(config.db).toBe('test_db');
    expect(config.apiKey).toBe('test_key_123');
  });

  it('should make an HTTP POST request with correct JSON-2 headers and body', async () => {
    const mockResponse = [{ id: 1, name: 'Main Company', currency_id: [1, 'USD'] }];
    
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      }),
    );

    const result = await service.callModel(
      { url: 'http://localhost:8069', db: 'client_db_a', apiKey: 'client_key_a' },
      'res.company',
      'search_read',
      { fields: ['id', 'name'], limit: 1 },
    );

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8069/json/2/res.company/search_read',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer client_key_a',
          'X-Odoo-Database': 'client_db_a',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: ['id', 'name'], limit: 1 }),
      },
    );
  });

  it('should throw UNAUTHORIZED on 401 response from Odoo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Invalid API Key' }),
      }),
    );

    await expect(
      service.callModel(
        { url: 'http://localhost:8069', db: 'client_db_a', apiKey: 'wrong_key' },
        'product.product',
        'search_read',
      ),
    ).rejects.toThrow(HttpException);
  });

  it('should return success true with company details when testConnection succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'My Odoo Enterprise', currency_id: [1, 'USD'] }],
      }),
    );

    const testResult = await service.testConnection({ db: 'custom_db' });

    expect(testResult.success).toBe(true);
    expect(testResult.database).toBe('custom_db');
    expect(testResult.company?.name).toBe('My Odoo Enterprise');
  });

  it('should return success false with error message when testConnection fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Connection refused')),
    );

    const testResult = await service.testConnection({ db: 'custom_db' });

    expect(testResult.success).toBe(false);
    expect(testResult.error).toContain('Connection refused');
  });
});
