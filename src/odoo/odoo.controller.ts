import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OdooClientService, OdooConnectionTestResult } from './odoo-client.service.js';

@Controller('odoo')
export class OdooController {
  constructor(
    private readonly odooClient: OdooClientService,
    private readonly configService: ConfigService,
  ) {}

  @Get('test-connection')
  async testConnection(): Promise<OdooConnectionTestResult> {
    if (this.configService.get<string>('ODOO_DIAGNOSTICS_ENABLED') !== 'true') {
      throw new NotFoundException();
    }
    return this.odooClient.testConnection();
  }
}
