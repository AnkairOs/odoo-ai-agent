import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const catalogText = /^[\p{L}\p{N}][\p{L}\p{N} ._()+&,'’#-]*$/u;
export const newProductSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(catalogText),
  reference: z.string().trim().min(1).max(255).regex(catalogText).optional(),
}).strict();

export type NewProduct = z.infer<typeof newProductSchema>;

const MAX_AMOUNT = 1_000_000;
const hasCents = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
export const salePriceSchema = z.number().positive().max(MAX_AMOUNT).refine(hasCents);
export const costSchema = z.number().min(0).max(MAX_AMOUNT).refine(hasCents);
export const taxIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const productCreationSchema = newProductSchema.extend({
  listPrice: salePriceSchema.optional(),
  standardPrice: costSchema.optional(),
  taxId: taxIdSchema.optional(),
}).strict();
export type ProductCreation = z.infer<typeof productCreationSchema>;

export const conversationProductSchema = newProductSchema.extend({
  salePrice: salePriceSchema.optional(),
  priceIncludesTax: z.boolean().optional(),
  taxId: taxIdSchema.optional(),
  cost: costSchema.optional(),
}).strict().refine((product) => (product.salePrice === undefined) === (product.priceIncludesTax === undefined) &&
  (product.taxId === undefined || product.salePrice !== undefined));
export type ConversationProduct = z.infer<typeof conversationProductSchema>;
export interface ProductDestination {
  url: string;
  db: string;
  companyId: number;
}
export type ProductCreationResult =
  | { status: 'created'; id: number }
  | { status: 'unknown' | 'rejected' | 'unavailable' };

export const batchProductCreationSchema = z.array(productCreationSchema).min(2).max(20);
export type ProductBatchCreationResult =
  | { status: 'created'; ids: number[] }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

const BATCH_MUTATION_TIMEOUT_MS = 15_000;

@Injectable()
export class OdooProductCreationService {
  constructor(private readonly config: ConfigService) {}

  destination(): ProductDestination | undefined {
    if (this.config.get<unknown>('ODOO_PRODUCT_CREATION_ENABLED') !== 'true') return;
    const company = this.config.get<unknown>('ODOO_PRODUCT_COMPANY_ID');
    const url = this.explicitString('ODOO_DEFAULT_URL');
    const db = this.explicitString('ODOO_DEFAULT_DB');
    if (typeof company !== 'string' || !/^[1-9]\d*$/u.test(company) ||
      !Number.isSafeInteger(Number(company)) || !url || !db ||
      !this.explicitString('ODOO_DEFAULT_API_KEY')) return;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username ||
        parsed.password || parsed.search || parsed.hash) return;
    } catch { return; }
    return { url, db, companyId: Number(company) };
  }

  async create(input: ProductCreation, expected: ProductDestination): Promise<ProductCreationResult> {
    const destination = this.destination();
    const product = productCreationSchema.safeParse(input);
    if (!destination || !sameProductDestination(destination, expected) || !product.success) {
      return { status: 'unavailable' };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProductCreationResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'unknown' });
      }, 10_000);
    });
    try {
      return await Promise.race([
        this.createOnce(product.data, destination, controller.signal), timeout,
      ]);
    } finally { clearTimeout(timer); }
  }

  async createBatch(products: ProductCreation[], expected: ProductDestination): Promise<ProductBatchCreationResult> {
    const destination = this.destination();
    const parsed = batchProductCreationSchema.safeParse(products);
    if (!destination || !sameProductDestination(destination, expected) || !parsed.success) {
      return { status: 'unavailable' };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProductBatchCreationResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'unknown' });
      }, BATCH_MUTATION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.createBatchOnce(parsed.data, destination, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async createOnce(product: ProductCreation, target: ProductDestination, signal: AbortSignal): Promise<ProductCreationResult> {
    try {
      const response = await fetch(`${target.url.replace(/\/+$/u, '')}/json/2/product.product/create`, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          Authorization: `Bearer ${this.explicitString('ODOO_DEFAULT_API_KEY')!}`,
          'X-Odoo-Database': target.db, 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ vals_list: [productValues(product, target)] }),
      });
      if (!response.ok) {
        return { status: [401, 403, 404].includes(response.status) ? 'rejected' : 'unknown' };
      }
      const ids: unknown = await response.json();
      return Array.isArray(ids) && ids.length === 1 && isValidProductId(ids[0])
        ? { status: 'created', id: ids[0] } : { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  }

  private async createBatchOnce(
    products: ProductCreation[],
    target: ProductDestination,
    signal: AbortSignal,
  ): Promise<ProductBatchCreationResult> {
    try {
      const response = await fetch(`${target.url.replace(/\/+$/u, '')}/json/2/product.product/create`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${this.explicitString('ODOO_DEFAULT_API_KEY')!}`,
          'X-Odoo-Database': target.db,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vals_list: products.map((product) => productValues(product, target)),
        }),
      });
      if (!response.ok) {
        return { status: [401, 403, 404].includes(response.status) ? 'rejected' : 'unknown' };
      }
      const ids: unknown = await response.json();
      return Array.isArray(ids) && ids.length === products.length && ids.every(isValidProductId)
        ? { status: 'created', ids }
        : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }

  private explicitString(key: string): string | undefined {
    const value = this.config.get<unknown>(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}

function productValues(product: ProductCreation, target: ProductDestination): Record<string, unknown> {
  return {
    name: product.name,
    ...(product.reference === undefined ? {} : { default_code: product.reference }),
    type: 'consu', is_storable: false, company_id: target.companyId,
    ...(product.listPrice === undefined ? {} : { list_price: product.listPrice }),
    ...(product.standardPrice === undefined ? {} : { standard_price: product.standardPrice }),
    ...(product.taxId === undefined ? {} : { taxes_id: [[6, 0, [product.taxId]]] }),
  };
}

function isValidProductId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

export function sameProductDestination(a: ProductDestination, b: ProductDestination): boolean {
  return a.url === b.url && a.db === b.db && a.companyId === b.companyId;
}

const RATE_SCALE = 1_000_000;

export function untaxedPrice(price: number, includesTax: boolean, percent: number): number {
  if (!includesTax) return price;
  const divisor = RATE_SCALE + rateUnits(percent);
  return Math.floor((2 * toCents(price) * RATE_SCALE + divisor) / (2 * divisor)) / 100;
}

export function taxedTotal(base: number, percent: number): number {
  const scaled = toCents(base) * (RATE_SCALE + rateUnits(percent));
  return Math.floor((scaled + RATE_SCALE / 2) / RATE_SCALE) / 100;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function rateUnits(percent: number): number {
  return Math.round(percent * RATE_SCALE / 100);
}
