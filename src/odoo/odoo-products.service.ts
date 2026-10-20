import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { OdooClientService } from './odoo-client.service.js';

export interface OdooProduct {
  id: number;
  name: string;
  default_code: string | null;
}

export type ProductSearchResult =
  | { status: 'ok'; products: OdooProduct[] }
  | { status: 'unavailable' };

@Injectable()
export class OdooProductsService {
  constructor(
    private readonly client: OdooClientService,
    private readonly config: ConfigService,
  ) {}

  async search(query: unknown): Promise<ProductSearchResult> {
    const parsed = productQuerySchema.safeParse(query);
    const url = this.config.get<string>('ODOO_DEFAULT_URL');
    const db = this.config.get<string>('ODOO_DEFAULT_DB');
    const apiKey = this.config.get<string>('ODOO_DEFAULT_API_KEY');
    if (!parsed.success || !url?.trim() || !db?.trim() || !apiKey?.trim()) {
      return { status: 'unavailable' };
    }

    try {
      const result = await this.client.callModel<unknown>(
        { url, db, apiKey },
        'product.product',
        'search_read',
        {
          domain: [
            ['active', '=', true],
            ['sale_ok', '=', true],
            '|',
            ['name', 'ilike', parsed.data],
            ['default_code', 'ilike', parsed.data],
          ],
          fields: ['id', 'name', 'default_code'],
          limit: 5,
        },
      );
      const records = productRecordsSchema.safeParse(result);
      return records.success
        ? { status: 'ok', products: records.data.slice(0, 5) }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }
}

export const productQuerySchema = z.string().trim().min(1).max(120);

const productRecordsSchema = z.array(z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  default_code: z.union([z.string(), z.literal(false), z.null()])
    .transform((code) => code === false ? null : code),
}));
