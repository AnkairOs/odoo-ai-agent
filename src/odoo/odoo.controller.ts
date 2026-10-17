import { Controller, Get, Query } from '@nestjs/common';
import { OdooClientService, OdooConnectionTestResult } from './odoo-client.service.js';

@Controller('odoo')
export class OdooController {
  constructor(private readonly odooClient: OdooClientService) {}

  @Get('test-connection')
  async testConnection(
    @Query('db') db?: string,
    @Query('url') url?: string,
    @Query('apiKey') apiKey?: string,
  ): Promise<OdooConnectionTestResult> {
    return this.odooClient.testConnection({
      db,
      url,
      apiKey,
    });
  }
}
