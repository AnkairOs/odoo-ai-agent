import { Module } from '@nestjs/common';
import { OdooClientService } from './odoo-client.service.js';
import { OdooController } from './odoo.controller.js';

@Module({
  controllers: [OdooController],
  providers: [OdooClientService],
  exports: [OdooClientService],
})
export class OdooModule {}
