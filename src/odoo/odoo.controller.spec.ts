import { describe, it, expect, vi, afterEach } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OdooController } from './odoo.controller.js';
import { OdooClientService } from './odoo-client.service.js';

describe('OdooController diagnostic', () => {
  let app: INestApplication;

  async function createApp(env: Record<string, string>) {
    const testConnection = vi.fn().mockResolvedValue({
      success: true,
      database: 'test_db',
      url: 'http://localhost:8069',
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [OdooController],
      providers: [
        { provide: OdooClientService, useValue: { testConnection } },
        { provide: ConfigService, useValue: new ConfigService(env) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return testConnection;
  }

  afterEach(async () => {
    await app.close();
  });

  it('is not reachable unless explicitly enabled', async () => {
    const testConnection = await createApp({});

    await request(app.getHttpServer()).get('/odoo/test-connection').expect(404);

    expect(testConnection).not.toHaveBeenCalled();
  });

  it('is not reachable when the flag has any value other than "true"', async () => {
    const testConnection = await createApp({ ODOO_DIAGNOSTICS_ENABLED: '1' });

    await request(app.getHttpServer()).get('/odoo/test-connection').expect(404);

    expect(testConnection).not.toHaveBeenCalled();
  });

  it('uses only server configuration and ignores client-supplied url, db and apiKey', async () => {
    const testConnection = await createApp({ ODOO_DIAGNOSTICS_ENABLED: 'true' });

    const response = await request(app.getHttpServer())
      .get('/odoo/test-connection')
      .query({ url: 'http://attacker.example', db: 'other', apiKey: 'stolen' })
      .expect(200);

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledWith();
    expect(response.body).toEqual({
      success: true,
      database: 'test_db',
      url: 'http://localhost:8069',
    });
  });
});
