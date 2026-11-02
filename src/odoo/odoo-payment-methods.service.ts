import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { OdooClientService } from './odoo-client.service.js';
import type { ProductDestination } from './odoo-product-creation.service.js';

export const paymentMethodSchema = z.object({
  id: z.number().int().positive(),
  accNumber: z.string().min(1),
  accHolderName: z.string().optional(),
  bankId: z.number().int().positive().optional(),
  bankName: z.string().optional(),
  bankBic: z.string().optional(),
  note: z.string().optional(),
  active: z.boolean(),
}).strict();
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const createPaymentMethodInputSchema = z.object({
  bankName: z.string().trim().min(1).max(100).optional(),
  accNumber: z.string().trim().min(1).max(64),
  accHolderName: z.string().trim().min(1).max(150).optional(),
  note: z.string().trim().min(1).max(255).optional(),
}).strict();
export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodInputSchema>;

export const updatePaymentMethodInputSchema = z.object({
  id: z.number().int().positive(),
  bankName: z.string().trim().min(1).max(100).optional(),
  accNumber: z.string().trim().min(1).max(64).optional(),
  accHolderName: z.string().trim().min(1).max(150).optional(),
  note: z.string().trim().min(1).max(255).optional(),
}).strict().refine(
  (data) => data.bankName !== undefined || data.accNumber !== undefined || data.accHolderName !== undefined || data.note !== undefined,
  { message: 'At least one field to update must be provided' },
);
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodInputSchema>;

export type PaymentMethodMutationResult =
  | { status: 'created'; id: number }
  | { status: 'updated'; id: number }
  | { status: 'archived'; id: number }
  | { status: 'rejected' | 'unknown' | 'unavailable' };

interface CacheEntry {
  methods: PaymentMethod[];
  expiresAt: number;
}

const CACHE_TTL_MS = 300_000;
const MUTATION_TIMEOUT_MS = 10_000;

@Injectable()
export class OdooPaymentMethodsService {
  private readonly logger = new Logger(OdooPaymentMethodsService.name);
  private cache: CacheEntry | null = null;
  private companyPartnerId: number | null = null;

  constructor(
    private readonly client: OdooClientService,
    private readonly config: ConfigService,
  ) {}

  clearCache(): void {
    this.cache = null;
    this.companyPartnerId = null;
  }

  destination(): ProductDestination | undefined {
    const company = this.config.get<unknown>('ODOO_PRODUCT_COMPANY_ID');
    const url = this.explicitString('ODOO_DEFAULT_URL');
    const db = this.explicitString('ODOO_DEFAULT_DB');
    if (
      typeof company !== 'string' &&
      typeof company !== 'number'
    ) {
      return undefined;
    }
    const companyId = Number(company);
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || !url || !db || !this.explicitString('ODOO_DEFAULT_API_KEY')) {
      return undefined;
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return { url, db, companyId };
  }

  async list(forceFresh = false): Promise<{ status: 'ok'; methods: PaymentMethod[] } | { status: 'unavailable' }> {
    const target = this.destination();
    if (!target) return { status: 'unavailable' };

    if (!forceFresh && this.cache && Date.now() < this.cache.expiresAt) {
      return { status: 'ok', methods: this.cache.methods };
    }

    try {
      const partnerId = await this.resolveCompanyPartnerId(target);
      const domain: unknown[] = [['active', '=', true]];
      if (partnerId) {
        domain.push('|', ['partner_id', '=', partnerId], ['company_id', '=', target.companyId]);
      } else {
        domain.push(['company_id', '=', target.companyId]);
      }

      const rows = await this.readSafely<Array<Record<string, unknown>>>(
        target,
        'res.partner.bank',
        'search_read',
        {
          domain,
          fields: ['id', 'acc_number', 'acc_holder_name', 'bank_id', 'bank_name', 'bank_bic', 'note', 'active'],
          order: 'id asc',
          limit: 50,
        },
      );

      if (!Array.isArray(rows)) {
        return { status: 'unavailable' };
      }

      const methods: PaymentMethod[] = rows.map((r) => {
        let bankId: number | undefined;
        let bankName: string | undefined;
        if (Array.isArray(r.bank_id) && typeof r.bank_id[0] === 'number') {
          bankId = r.bank_id[0];
          bankName = typeof r.bank_id[1] === 'string' ? r.bank_id[1] : undefined;
        } else if (typeof r.bank_name === 'string' && r.bank_name.trim()) {
          bankName = r.bank_name.trim();
        }

        return {
          id: Number(r.id),
          accNumber: String(r.acc_number ?? ''),
          accHolderName: typeof r.acc_holder_name === 'string' && r.acc_holder_name.trim() ? r.acc_holder_name.trim() : undefined,
          bankId,
          bankName,
          bankBic: typeof r.bank_bic === 'string' && r.bank_bic.trim() ? r.bank_bic.trim() : undefined,
          note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
          active: Boolean(r.active ?? true),
        };
      });

      this.cache = { methods, expiresAt: Date.now() + CACHE_TTL_MS };
      return { status: 'ok', methods };
    } catch (err) {
      this.logger.warn(`Failed to list payment methods: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'unavailable' };
    }
  }

  async getById(id: number): Promise<PaymentMethod | undefined> {
    const listRes = await this.list();
    if (listRes.status === 'ok') {
      const found = listRes.methods.find((m) => m.id === id);
      if (found) return found;
    }
    const target = this.destination();
    if (!target) return undefined;
    const rows = await this.readSafely<Array<Record<string, unknown>>>(
      target,
      'res.partner.bank',
      'search_read',
      {
        domain: [['id', '=', id]],
        fields: ['id', 'acc_number', 'acc_holder_name', 'bank_id', 'bank_name', 'bank_bic', 'note', 'active'],
        limit: 1,
      },
    );
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    const r = rows[0];
    let bankId: number | undefined;
    let bankName: string | undefined;
    if (Array.isArray(r.bank_id) && typeof r.bank_id[0] === 'number') {
      bankId = r.bank_id[0];
      bankName = typeof r.bank_id[1] === 'string' ? r.bank_id[1] : undefined;
    } else if (typeof r.bank_name === 'string' && r.bank_name.trim()) {
      bankName = r.bank_name.trim();
    }
    return {
      id: Number(r.id),
      accNumber: String(r.acc_number ?? ''),
      accHolderName: typeof r.acc_holder_name === 'string' && r.acc_holder_name.trim() ? r.acc_holder_name.trim() : undefined,
      bankId,
      bankName,
      bankBic: typeof r.bank_bic === 'string' && r.bank_bic.trim() ? r.bank_bic.trim() : undefined,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
      active: Boolean(r.active ?? true),
    };
  }

  async create(input: CreatePaymentMethodInput): Promise<PaymentMethodMutationResult> {
    const target = this.destination();
    const parsed = createPaymentMethodInputSchema.safeParse(input);
    if (!target || !parsed.success) return { status: 'unavailable' };

    const partnerId = await this.resolveCompanyPartnerId(target);
    if (!partnerId) return { status: 'unavailable' };

    let bankId: number | undefined;
    if (parsed.data.bankName) {
      bankId = await this.findOrCreateBank(target, parsed.data.bankName);
    }

    const vals: Record<string, unknown> = {
      acc_number: parsed.data.accNumber,
      partner_id: partnerId,
      company_id: target.companyId,
    };
    if (parsed.data.accHolderName) vals.acc_holder_name = parsed.data.accHolderName;
    if (parsed.data.note) vals.note = parsed.data.note;
    if (bankId) vals.bank_id = bankId;

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const res = await this.executeTimedCall<number[]>(target, apiKey, 'res.partner.bank', 'create', {
      vals_list: [vals],
    });

    if (res.status === 'ok' && Array.isArray(res.data) && res.data.length > 0 && typeof res.data[0] === 'number') {
      this.clearCache();
      return { status: 'created', id: res.data[0] };
    }
    return { status: res.status === 'rejected' ? 'rejected' : 'unknown' };
  }

  async update(input: UpdatePaymentMethodInput): Promise<PaymentMethodMutationResult> {
    const target = this.destination();
    const parsed = updatePaymentMethodInputSchema.safeParse(input);
    if (!target || !parsed.success) return { status: 'unavailable' };

    const vals: Record<string, unknown> = {};
    if (parsed.data.accNumber !== undefined) vals.acc_number = parsed.data.accNumber;
    if (parsed.data.accHolderName !== undefined) vals.acc_holder_name = parsed.data.accHolderName;
    if (parsed.data.note !== undefined) vals.note = parsed.data.note;
    if (parsed.data.bankName !== undefined) {
      const bankId = await this.findOrCreateBank(target, parsed.data.bankName);
      if (bankId) vals.bank_id = bankId;
    }

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const res = await this.executeTimedCall<boolean>(target, apiKey, 'res.partner.bank', 'write', {
      ids: [parsed.data.id],
      vals,
    });

    if (res.status === 'ok' && res.data === true) {
      this.clearCache();
      return { status: 'updated', id: parsed.data.id };
    }
    return { status: res.status === 'rejected' ? 'rejected' : 'unknown' };
  }

  async archive(id: number): Promise<PaymentMethodMutationResult> {
    const target = this.destination();
    if (!target || !Number.isSafeInteger(id) || id <= 0) return { status: 'unavailable' };

    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
    const res = await this.executeTimedCall<boolean>(target, apiKey, 'res.partner.bank', 'write', {
      ids: [id],
      vals: { active: false },
    });

    if (res.status === 'ok' && res.data === true) {
      this.clearCache();
      return { status: 'archived', id };
    }
    return { status: res.status === 'rejected' ? 'rejected' : 'unknown' };
  }

  async findOrCreateBank(target: ProductDestination, bankName: string): Promise<number | undefined> {
    const trimmed = bankName.trim();
    if (!trimmed) return undefined;
    try {
      const rows = await this.readSafely<Array<{ id: number; name: string }>>(
        target,
        'res.bank',
        'search_read',
        {
          domain: [['name', 'ilike', trimmed]],
          fields: ['id', 'name'],
          limit: 1,
        },
      );
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0].id === 'number') {
        return rows[0].id;
      }
      const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY')!;
      const created = await this.executeTimedCall<number[]>(target, apiKey, 'res.bank', 'create', {
        vals_list: [{ name: trimmed }],
      });
      if (created.status === 'ok' && Array.isArray(created.data) && typeof created.data[0] === 'number') {
        return created.data[0];
      }
    } catch (e) {
      this.logger.warn(`Failed to find or create bank "${trimmed}": ${e instanceof Error ? e.message : String(e)}`);
    }
    return undefined;
  }

  private async resolveCompanyPartnerId(target: ProductDestination): Promise<number | undefined> {
    if (this.companyPartnerId) return this.companyPartnerId;
    try {
      const rows = await this.readSafely<Array<{ id: number; partner_id: [number, string] | false }>>(
        target,
        'res.company',
        'read',
        {
          ids: [target.companyId],
          fields: ['id', 'partner_id'],
        },
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const p = rows[0].partner_id;
        if (Array.isArray(p) && typeof p[0] === 'number') {
          this.companyPartnerId = p[0];
          return this.companyPartnerId;
        }
      }
    } catch { /* ignore */ }
    return undefined;
  }

  private async readSafely<T>(
    target: ProductDestination,
    model: string,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T | undefined> {
    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY');
    if (!apiKey) return undefined;
    try {
      return await this.client.callModel<T>(
        { url: target.url, db: target.db, apiKey },
        model,
        method,
        payload,
      );
    } catch {
      return undefined;
    }
  }

  private async executeTimedCall<T>(
    target: ProductDestination,
    apiKey: string,
    model: string,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: 'ok'; data: T } | { status: 'rejected' | 'unknown' }> {
    try {
      const endpoint = `${target.url.replace(/\/+$/u, '')}/json/2/${model}/${method}`;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ status: 'unknown' }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: 'unknown' });
        }, MUTATION_TIMEOUT_MS);
      });

      const call = (async () => {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'X-Odoo-Database': target.db,
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0',
            },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            return { status: [401, 403, 404].includes(response.status) ? ('rejected' as const) : ('unknown' as const) };
          }
          const data = (await response.json()) as T;
          return { status: 'ok' as const, data };
        } catch {
          return { status: 'unknown' as const };
        }
      })();

      try {
        return await Promise.race([call, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return { status: 'unknown' };
    }
  }

  private explicitString(key: string): string | undefined {
    const value = this.config.get<unknown>(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}
