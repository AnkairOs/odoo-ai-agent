import { Module } from '@nestjs/common';
import { OdooProductCreationService } from './odoo-product-creation.service.js';
import { OdooProductUpdateService } from './odoo-product-update.service.js';
import { OdooClientService } from './odoo-client.service.js';
import { OdooController } from './odoo.controller.js';
import { OdooProductsService } from './odoo-products.service.js';
import { OdooTaxesService } from './odoo-taxes.service.js';
import { OdooOperatorService } from './odoo-operator.service.js';

@Module({
  controllers: [OdooController],
  providers: [
    OdooClientService,
    OdooProductsService,
    OdooProductCreationService,
    OdooProductUpdateService,
    OdooTaxesService,
    OdooOperatorService,
  ],
  exports: [
    OdooClientService,
    OdooProductsService,
    OdooProductCreationService,
    OdooProductUpdateService,
    OdooTaxesService,
    OdooOperatorService,
  ],
})
export class OdooModule {}

