import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OdooClientService } from './odoo-client.service.js';

const CACHE_TTL_MS = 300_000;
const ERROR_CACHE_TTL_MS = 60_000;
const QUERY_TIMEOUT_MS = 5_000;

interface OperatorDestination {
  readonly url: string;
  readonly db: string;
  readonly apiKey: string;
  readonly companyId: number;
}

interface CacheEntry {
  readonly phone: string | undefined;
  readonly expiresAt: number;
}

@Injectable()
export class OdooOperatorService {
  private readonly logger = new Logger(OdooOperatorService.name);
  private cache: CacheEntry | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly odooClient: OdooClientService,
  ) {}

  async resolveOperatorPhone(): Promise<string | undefined> {
    const destination = this.resolveDestination();
    if (!destination) {
      return this.resolveFallbackPhone();
    }

    if (this.isCacheValid() && this.cache) {
      return this.cache.phone;
    }

    return await this.fetchAndCacheOperatorPhone(destination);
  }

  clearCache(): void {
    this.cache = null;
  }

  private resolveDestination(): OperatorDestination | undefined {
    const url = this.explicitString('ODOO_DEFAULT_URL');
    const db = this.explicitString('ODOO_DEFAULT_DB');
    const apiKey = this.explicitString('ODOO_DEFAULT_API_KEY');
    const companyId = this.parseCompanyId(this.config.get<unknown>('ODOO_PRODUCT_COMPANY_ID'));

    if (!url || !db || !apiKey || companyId === undefined) {
      return undefined;
    }

    if (!this.isValidHttpUrl(url)) {
      return undefined;
    }

    return { url, db, apiKey, companyId };
  }

  private explicitString(key: string): string | undefined {
    const value = this.config.get<unknown>(key);
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseCompanyId(raw: unknown): number | undefined {
    if (typeof raw === 'number') {
      return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!/^[1-9]\d*$/u.test(trimmed)) {
        return undefined;
      }
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private isValidHttpUrl(candidate: string): boolean {
    try {
      const parsed = new URL(candidate);
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }

  private isCacheValid(): boolean {
    if (!this.cache) {
      return false;
    }
    if (Date.now() >= this.cache.expiresAt) {
      this.cache = null;
      return false;
    }
    return true;
  }

  private async fetchAndCacheOperatorPhone(
    destination: OperatorDestination,
  ): Promise<string | undefined> {
    try {
      const rawResult = await this.queryCompanyPhone(destination);
      const rawPhone = this.extractPhone(rawResult);
      const normalized = this.normalizePhone(rawPhone);

      const resolved = normalized ?? this.resolveFallbackPhone();
      this.cachePhone(resolved, CACHE_TTL_MS);
      return resolved;
    } catch (error) {
      this.logger.warn(
        `Failed to query operator phone from Odoo: ${error instanceof Error ? error.message : String(error)}`,
      );
      const fallback = this.resolveFallbackPhone();
      this.cachePhone(fallback, ERROR_CACHE_TTL_MS);
      return fallback;
    }
  }

  private async queryCompanyPhone(destination: OperatorDestination): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Odoo operator query timed out after ${QUERY_TIMEOUT_MS}ms`));
      }, QUERY_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.odooClient.callModel<unknown>(
          {
            url: destination.url,
            db: destination.db,
            apiKey: destination.apiKey,
          },
          'res.company',
          'read',
          {
            ids: [destination.companyId],
            fields: ['id', 'phone'],
          },
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private extractPhone(rawResult: unknown): unknown {
    if (!Array.isArray(rawResult) || rawResult.length === 0) {
      return undefined;
    }
    const first: unknown = rawResult[0];
    if (typeof first !== 'object' || first === null) {
      return undefined;
    }
    const record = first as Record<string, unknown>;
    return record.phone;
  }

  private normalizePhone(raw: unknown): string | undefined {
    if (typeof raw !== 'string') {
      return undefined;
    }
    const digits = raw.replace(/\D/gu, '');
    if (!digits) {
      return undefined;
    }

    if (digits.startsWith('09') && digits.length === 10) {
      return `593${digits.slice(1)}`;
    }

    if (digits.startsWith('9') && digits.length === 9) {
      return `593${digits}`;
    }

    if (digits.startsWith('593') && digits.length >= 11 && digits.length <= 15) {
      return digits;
    }

    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }

    return undefined;
  }

  private cachePhone(phone: string | undefined, ttlMs: number): void {
    this.cache = {
      phone,
      expiresAt: Date.now() + ttlMs,
    };
  }

  private resolveFallbackPhone(): string | undefined {
    const configured = this.config.get<unknown>('RELAY_OPERATOR_WA_ID');
    if (typeof configured !== 'string') {
      return undefined;
    }
    const trimmed = configured.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
