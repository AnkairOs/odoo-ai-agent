import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  costSchema,
  salePriceSchema,
  sameProductDestination,
  taxIdSchema,
  type ProductDestination,
} from './odoo-product-creation.service.js';

const catalogText = /^[\p{L}\p{N}][\p{L}\p{N} ._()+&,'’#-]*$/u;

export const productUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(catalogText).optional(),
  reference: z.string().trim().min(1).max(255).regex(catalogText).optional(),
  listPrice: salePriceSchema.optional(),
  standardPrice: costSchema.optional(),
  taxId: taxIdSchema.optional(),
}).strict().refine(
  (data) =>
    data.name !== undefined ||
    data.reference !== undefined ||
    data.listPrice !== undefined ||
    data.standardPrice !== undefined ||
    data.taxId !== undefined,
  { message: 'At least one field must be provided' },
);

export type ProductUpdate = z.infer<typeof productUpdateSchema>;

export type ProductUpdateResult =
  | { status: 'updated' }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

export type ProductArchiveResult =
  | { status: 'archived' }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

const MUTATION_TIMEOUT_MS = 10_000;

@Injectable()
export class OdooProductUpdateService {
  constructor(private readonly config: ConfigService) {}

  destination(): ProductDestination | undefined {
    if (this.config.get<unknown>('ODOO_PRODUCT_CREATION_ENABLED') !== 'true') return;
    const company = this.config.get<unknown>('ODOO_PRODUCT_COMPANY_ID');
    const url = this.explicitString('ODOO_DEFAULT_URL');
    const db = this.explicitString('ODOO_DEFAULT_DB');
    if (
      typeof company !== 'string' ||
      !/^[1-9]\d*$/u.test(company) ||
      !Number.isSafeInteger(Number(company)) ||
      !url ||
      !db ||
      !this.explicitString('ODOO_DEFAULT_API_KEY')
    ) {
      return;
    }
    try {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        return;
      }
    } catch {
      return;
    }
    return { url, db, companyId: Number(company) };
  }

  async update(
    id: number,
    input: ProductUpdate,
    expected: ProductDestination,
  ): Promise<ProductUpdateResult> {
    const destination = this.destination();
    const product = productUpdateSchema.safeParse(input);
    if (!destination || !sameProductDestination(destination, expected) || !isValidProductId(id) || !product.success) {
      return { status: 'unavailable' };
    }

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const vals = buildUpdateVals(product.data);
    const result = await this.executeTimedWrite(destination, apiKey, id, vals);
    if (result === 'ok') {
      return { status: 'updated' };
    }
    return { status: result };
  }

  async archive(
    id: number,
    expected: ProductDestination,
  ): Promise<ProductArchiveResult> {
    const destination = this.destination();
    if (!destination || !sameProductDestination(destination, expected) || !isValidProductId(id)) {
      return { status: 'unavailable' };
    }

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const result = await this.executeTimedWrite(destination, apiKey, id, { active: false });
    if (result === 'ok') {
      return { status: 'archived' };
    }
    return { status: result };
  }

  private async executeTimedWrite(
    target: ProductDestination,
    apiKey: string,
    id: number,
    vals: Record<string, unknown>,
  ): Promise<'ok' | 'rejected' | 'unknown'> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'unknown'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('unknown');
      }, MUTATION_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.writeOnce(target, apiKey, id, vals, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async writeOnce(
    target: ProductDestination,
    apiKey: string,
    id: number,
    vals: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<'ok' | 'rejected' | 'unknown'> {
    try {
      const endpoint = `${target.url.replace(/\/+$/u, '')}/json/2/product.product/write`;
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Odoo-Database': target.db,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: [id], vals }),
      });

      if (!response.ok) {
        return [401, 403, 404].includes(response.status) ? 'rejected' : 'unknown';
      }

      const body: unknown = await response.json();
      return body === true ? 'ok' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private explicitString(key: string): string | undefined {
    const value = this.config.get<unknown>(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}

function isValidProductId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0;
}

function buildUpdateVals(product: ProductUpdate): Record<string, unknown> {
  const vals: Record<string, unknown> = {};
  if (product.name !== undefined) {
    vals.name = product.name;
  }
  if (product.reference !== undefined) {
    vals.default_code = product.reference;
  }
  if (product.listPrice !== undefined) {
    vals.list_price = product.listPrice;
  }
  if (product.standardPrice !== undefined) {
    vals.standard_price = product.standardPrice;
  }
  if (product.taxId !== undefined) {
    vals.taxes_id = [[6, 0, [product.taxId]]];
  }
  return vals;
}
