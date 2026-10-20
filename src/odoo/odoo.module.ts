import { Module } from '@nestjs/common';
import { OdooProductCreationService } from './odoo-product-creation.service.js';
import { OdooClientService } from './odoo-client.service.js';
import { OdooController } from './odoo.controller.js';
import { OdooProductsService } from './odoo-products.service.js';
import { OdooTaxesService } from './odoo-taxes.service.js';

@Module({
  controllers: [OdooController],
  providers: [OdooClientService, OdooProductsService, OdooProductCreationService, OdooTaxesService],
  exports: [OdooClientService, OdooProductsService, OdooProductCreationService, OdooTaxesService],
})
export class OdooModule {}
