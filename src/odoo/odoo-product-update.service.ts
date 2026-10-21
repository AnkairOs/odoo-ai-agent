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

export const batchArchiveIdsSchema = z
  .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .min(2)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Product IDs must be unique',
  });

export const batchUpdateItemSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    input: productUpdateSchema,
  })
  .strict();

export const batchProductUpdateSchema = z
  .array(batchUpdateItemSchema)
  .min(2)
  .max(20)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: 'Product IDs must be unique',
  });

export type BatchUpdateItem = z.infer<typeof batchUpdateItemSchema>;

export type ProductUpdateResult =
  | { status: 'updated' }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

export type ProductArchiveResult =
  | { status: 'archived' }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

export type ProductBatchArchiveResult =
  | { status: 'archived'; ids: number[] }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

export interface ProductBatchUpdateProgress {
  updatedIds: number[];
  rejectedIds: number[];
  unknownIds: number[];
  notAttemptedIds: number[];
}

export type ProductBatchUpdateResult =
  | { status: 'updated'; count: number }
  | { status: 'unavailable' }
  | ({ status: 'partial' | 'rejected' | 'unknown' } & ProductBatchUpdateProgress);

type BatchWriteGroup = {
  ids: number[];
  vals: Record<string, unknown>;
  outcome: 'notAttempted' | 'inFlight' | 'updated' | 'rejected' | 'unknown';
};

const MUTATION_TIMEOUT_MS = 10_000;
const BATCH_MUTATION_TIMEOUT_MS = 15_000;

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

  async archiveBatch(
    ids: number[],
    expected: ProductDestination,
  ): Promise<ProductBatchArchiveResult> {
    const destination = this.destination();
    const parsed = batchArchiveIdsSchema.safeParse(ids);
    if (!destination || !sameProductDestination(destination, expected) || !parsed.success) {
      return { status: 'unavailable' };
    }

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProductBatchArchiveResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'unknown' });
      }, BATCH_MUTATION_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.archiveBatchOnce(destination, apiKey, parsed.data, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async updateBatch(
    items: { id: number; input: ProductUpdate }[],
    expected: ProductDestination,
  ): Promise<ProductBatchUpdateResult> {
    const destination = this.destination();
    const parsed = batchProductUpdateSchema.safeParse(items);
    if (!destination || !sameProductDestination(destination, expected) || !parsed.success) {
      return { status: 'unavailable' };
    }

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const groups: BatchWriteGroup[] = groupUpdateItems(parsed.data)
      .map((group) => ({ ...group, outcome: 'notAttempted' }));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProductBatchUpdateResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(batchUpdateFailure(groups));
      }, BATCH_MUTATION_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.executeBatchWrites(destination, apiKey, groups, parsed.data.length, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
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
        this.writeOnce(target, apiKey, [id], vals, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async archiveBatchOnce(
    target: ProductDestination,
    apiKey: string,
    ids: number[],
    signal: AbortSignal,
  ): Promise<ProductBatchArchiveResult> {
    const result = await this.writeOnce(target, apiKey, ids, { active: false }, signal);
    if (result === 'ok') {
      return { status: 'archived', ids };
    }
    return { status: result };
  }

  private async executeBatchWrites(
    target: ProductDestination,
    apiKey: string,
    groups: BatchWriteGroup[],
    totalCount: number,
    signal: AbortSignal,
  ): Promise<ProductBatchUpdateResult> {
    for (const group of groups) {
      if (signal.aborted) return batchUpdateFailure(groups);
      group.outcome = 'inFlight';
      const result = await this.writeOnce(target, apiKey, group.ids, group.vals, signal);
      if (signal.aborted) return batchUpdateFailure(groups);
      group.outcome = result === 'ok' ? 'updated' : result;
      if (result !== 'ok') return batchUpdateFailure(groups);
    }
    return { status: 'updated', count: totalCount };
  }

  private async writeOnce(
    target: ProductDestination,
    apiKey: string,
    ids: number[],
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
        body: JSON.stringify({ ids, vals }),
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

function batchUpdateFailure(groups: BatchWriteGroup[]): ProductBatchUpdateResult {
  const progress: ProductBatchUpdateProgress = {
    updatedIds: [], rejectedIds: [], unknownIds: [], notAttemptedIds: [],
  };
  for (const group of groups) {
    const key = group.outcome === 'inFlight' ? 'unknownIds' : `${group.outcome}Ids` as const;
    progress[key].push(...group.ids);
  }
  const status = progress.updatedIds.length > 0 ? 'partial'
    : progress.unknownIds.length > 0 ? 'unknown'
      : progress.rejectedIds.length > 0 ? 'rejected' : 'unknown';
  return { status, ...progress };
}

function groupUpdateItems(
  items: { id: number; input: ProductUpdate }[],
): { ids: number[]; vals: Record<string, unknown> }[] {
  const groups = new Map<string, { ids: number[]; vals: Record<string, unknown> }>();
  for (const item of items) {
    const vals = buildUpdateVals(item.input);
    const key = JSON.stringify(vals);
    const existing = groups.get(key);
    if (existing) {
      existing.ids.push(item.id);
    } else {
      groups.set(key, { ids: [item.id], vals });
    }
  }
  return Array.from(groups.values());
}

function isValidProductId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
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
