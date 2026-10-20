import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { OdooClientService } from './odoo-client.service.js';
import type { ProductDestination } from './odoo-product-creation.service.js';

export const saleTaxSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(120),
  percent: z.number().min(0).max(100),
}).strict();
export type SaleTax = z.infer<typeof saleTaxSchema>;

export type SaleTaxListResult = { status: 'ok'; taxes: SaleTax[] } | { status: 'unavailable' };
export type DefaultSaleTaxResult = { status: 'ok'; taxId: number | null } | { status: 'unavailable' };

const MAX_TAXES = 50;

@Injectable()
export class OdooTaxesService {
  constructor(
    private readonly client: OdooClientService,
    private readonly config: ConfigService,
  ) {}

  async listSaleTaxes(target: ProductDestination): Promise<SaleTaxListResult> {
    const records = taxRecordsSchema.safeParse(await this.readSafely(target, 'account.tax', 'search_read', {
      domain: [['active', '=', true], ['type_tax_use', '=', 'sale'], ['amount_type', '=', 'percent'],
        ['company_id', '=', target.companyId]],
      fields: ['id', 'name', 'amount', 'price_include'], limit: MAX_TAXES,
    }));
    if (!records.success) return { status: 'unavailable' };
    return { status: 'ok', taxes: records.data.filter((tax) => !tax.price_include)
      .map(({ id, name, amount }) => ({ id, name, percent: amount })) };
  }

  async defaultSaleTaxId(target: ProductDestination): Promise<DefaultSaleTaxResult> {
    const records = companyRecordsSchema.safeParse(await this.readSafely(target, 'res.company', 'read', {
      ids: [target.companyId], fields: ['account_sale_tax_id'],
    }));
    if (!records.success || records.data[0].id !== target.companyId) return { status: 'unavailable' };
    const tax = records.data[0].account_sale_tax_id;
    return { status: 'ok', taxId: tax === false ? null : tax[0] };
  }

  private async readSafely(target: ProductDestination, model: string, method: string,
    payload: Record<string, unknown>): Promise<unknown> {
    const apiKey = this.config.get<unknown>('ODOO_DEFAULT_API_KEY');
    if (typeof apiKey !== 'string' || !apiKey.trim()) return undefined;
    try {
      return await this.client.callModel<unknown>({ url: target.url, db: target.db, apiKey: apiKey.trim() }, model, method, payload);
    } catch {
      return undefined;
    }
  }
}

const taxRecordsSchema = z.array(z.object({
  id: saleTaxSchema.shape.id,
  name: saleTaxSchema.shape.name,
  amount: saleTaxSchema.shape.percent,
  price_include: z.boolean(),
})).max(MAX_TAXES);

const companyRecordsSchema = z.array(z.object({
  id: z.number().int().positive(),
  account_sale_tax_id: z.union([z.literal(false), z.tuple([saleTaxSchema.shape.id, z.string()])]),
})).length(1);
