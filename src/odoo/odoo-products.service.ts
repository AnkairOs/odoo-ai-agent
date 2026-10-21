import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { OdooClientService } from './odoo-client.service.js';

export interface OdooProduct {
  id: number;
  name: string;
  default_code: string | null;
  list_price: number;
  taxes_id: number[];
}

export interface OdooProductDetail {
  id: number;
  name: string;
  default_code: string | null;
  list_price: number;
  standard_price: number;
  taxes_id: number[];
  active: boolean;
}

export type ProductSearchResult =
  | { status: 'ok'; products: OdooProduct[]; total: number; offset: number }
  | { status: 'unavailable' };

export type ProductGetResult =
  | { status: 'ok'; product: OdooProductDetail | undefined }
  | { status: 'unavailable' };

@Injectable()
export class OdooProductsService {
  constructor(
    private readonly client: OdooClientService,
    private readonly config: ConfigService,
  ) {}

  async search(input?: unknown): Promise<ProductSearchResult> {
    const parsed = productSearchInputSchema.safeParse(input);
    const url = this.config.get<string>('ODOO_DEFAULT_URL');
    const db = this.config.get<string>('ODOO_DEFAULT_DB');
    const apiKey = this.config.get<string>('ODOO_DEFAULT_API_KEY');
    if (!parsed.success || !url?.trim() || !db?.trim() || !apiKey?.trim()) {
      return { status: 'unavailable' };
    }

    const { query, offset } = resolveSearchParams(parsed.data);
    const hasSearchTerm = query !== undefined && query.length > 0;
    const domain = hasSearchTerm
      ? [
          ['active', '=', true],
          ['sale_ok', '=', true],
          '|',
          ['name', 'ilike', query],
          ['default_code', 'ilike', query],
        ]
      : [
          ['active', '=', true],
          ['sale_ok', '=', true],
        ];
    const order = hasSearchTerm ? 'name asc' : 'id desc';

    try {
      const result = await this.client.callModel<unknown>(
        { url, db, apiKey },
        'product.product',
        'search_read',
        {
          domain,
          fields: ['id', 'name', 'default_code', 'list_price', 'taxes_id'],
          offset,
          limit: 5,
          order,
        },
      );
      const records = productRecordsSchema.safeParse(result);
      if (!records.success) {
        return { status: 'unavailable' };
      }

      const countRaw = await this.client.callModel<unknown>(
        { url, db, apiKey },
        'product.product',
        'search_count',
        { domain },
      );
      const total = countSchema.safeParse(countRaw);
      if (!total.success) {
        return { status: 'unavailable' };
      }

      return {
        status: 'ok',
        products: records.data.slice(0, 5),
        total: total.data,
        offset,
      };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async getById(id: number): Promise<ProductGetResult> {
    const parsedId = productIdSchema.safeParse(id);
    const url = this.config.get<string>('ODOO_DEFAULT_URL');
    const db = this.config.get<string>('ODOO_DEFAULT_DB');
    const apiKey = this.config.get<string>('ODOO_DEFAULT_API_KEY');
    if (!parsedId.success || !url?.trim() || !db?.trim() || !apiKey?.trim()) {
      return { status: 'unavailable' };
    }

    try {
      const result = await this.client.callModel<unknown>(
        { url, db, apiKey },
        'product.product',
        'read',
        {
          ids: [parsedId.data],
          fields: ['id', 'name', 'default_code', 'list_price', 'standard_price', 'taxes_id', 'active'],
        },
      );
      const records = productDetailRecordsSchema.safeParse(result);
      if (!records.success) {
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        product: records.data.length > 0 ? records.data[0] : undefined,
      };
    } catch {
      return { status: 'unavailable' };
    }
  }
}

export const productIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const productQuerySchema = z.string().trim().min(1).max(120);

export const productSearchInputSchema = z.union([
  z.string().trim().max(120),
  z.object({
    query: z.string().trim().max(120).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
  }).strict(),
]).optional();

type ParsedSearchInput = z.infer<typeof productSearchInputSchema>;

function resolveSearchParams(input: ParsedSearchInput): { query: string | undefined; offset: number } {
  if (input === undefined) {
    return { query: undefined, offset: 0 };
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return { query: trimmed.length > 0 ? trimmed : undefined, offset: 0 };
  }
  const trimmed = input.query?.trim();
  return {
    query: trimmed && trimmed.length > 0 ? trimmed : undefined,
    offset: input.offset ?? 0,
  };
}

const countSchema = z.number().int().min(0);

const productRecordsSchema = z.array(z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  default_code: z.union([z.string(), z.literal(false), z.null()])
    .transform((code) => code === false ? null : code),
  list_price: z.number().min(0),
  taxes_id: z.union([z.array(z.number().int().positive()), z.literal(false)])
    .transform((taxes) => taxes === false ? [] : taxes),
}));

const productDetailRecordsSchema = z.array(z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  default_code: z.union([z.string(), z.literal(false), z.null()])
    .transform((code) => code === false ? null : code),
  list_price: z.number().min(0),
  standard_price: z.number().min(0),
  taxes_id: z.array(z.number().int().positive()),
  active: z.boolean(),
}));
