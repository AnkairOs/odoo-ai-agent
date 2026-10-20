import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OdooTenantConfig } from './odoo.types.js';

interface OdooCompanyRecord {
  id: number;
  name: string;
  currency_id?: unknown;
}

export interface OdooConnectionTestResult {
  success: boolean;
  database: string;
  url: string;
  company?: {
    id: number;
    name: string;
    currency?: unknown;
  };
  error?: string;
}

function isCompanyRecord(value: unknown): value is OdooCompanyRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'number' && typeof candidate.name === 'string';
}

function isCompanyRecordArray(value: unknown): value is OdooCompanyRecord[] {
  return Array.isArray(value) && value.every(isCompanyRecord);
}

@Injectable()
export class OdooClientService {
  private readonly logger = new Logger(OdooClientService.name);

  constructor(private readonly configService: ConfigService) {}

  getDefaultConfig(): OdooTenantConfig {
    return {
      url: this.configService.get<string>('ODOO_DEFAULT_URL', 'http://localhost:8069'),
      db: this.configService.get<string>('ODOO_DEFAULT_DB', 'odoo'),
      apiKey: this.configService.get<string>('ODOO_DEFAULT_API_KEY', ''),
    };
  }

  async testConnection(
    customConfig?: Partial<OdooTenantConfig>,
  ): Promise<OdooConnectionTestResult> {
    const config = this.resolveConfig(customConfig);

    try {
      const rawResult = await this.callModel<unknown>(
        config,
        'res.company',
        'search_read',
        {
          fields: ['id', 'name', 'currency_id'],
          limit: 1,
        },
      );

      const mainCompany = this.extractPrimaryCompany(rawResult);

      return {
        success: true,
        database: config.db,
        url: config.url,
        company: mainCompany
          ? {
              id: mainCompany.id,
              name: mainCompany.name,
              currency: mainCompany.currency_id,
            }
          : undefined,
      };
    } catch (error) {
      return {
        success: false,
        database: config.db,
        url: config.url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveConfig(customConfig?: Partial<OdooTenantConfig>): OdooTenantConfig {
    const defaultConfig = this.getDefaultConfig();
    return {
      url: customConfig?.url || defaultConfig.url,
      db: customConfig?.db || defaultConfig.db,
      apiKey: customConfig?.apiKey || defaultConfig.apiKey,
    };
  }

  private extractPrimaryCompany(rawResult: unknown): OdooCompanyRecord | undefined {
    if (!isCompanyRecordArray(rawResult) || rawResult.length === 0) {
      return undefined;
    }
    return rawResult[0];
  }

  async callModel<T = unknown>(
    config: OdooTenantConfig,
    model: string,
    method: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const endpoint = this.buildEndpoint(config.url, model, method);
    const headers = this.buildHeaders(config.apiKey, config.db);

    this.logger.debug(
      `Invoking Odoo JSON-2: [${config.db}] POST /json/2/${model}/${method}`,
    );

    const response = await this.executeHttpRequest(endpoint, headers, payload, config.url);

    if (!response.ok) {
      await this.handleHttpError(response, model, method, config.db);
    }

    return (await response.json()) as T;
  }

  private buildEndpoint(baseUrl: string, model: string, method: string): string {
    const cleanUrl = baseUrl.replace(/\/+$/, '');
    return `${cleanUrl}/json/2/${model}/${method}`;
  }

  private buildHeaders(apiKey: string, db: string): HeadersInit {
    return {
      Authorization: `Bearer ${apiKey}`,
      'X-Odoo-Database': db,
      'Content-Type': 'application/json',
    };
  }

  private async executeHttpRequest(
    endpoint: string,
    headers: HeadersInit,
    payload: Record<string, unknown>,
    serverUrl: string,
  ): Promise<Response> {
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network error';
      this.logger.error(`Network error connecting to Odoo at ${endpoint}: ${message}`);
      throw new HttpException(
        `Failed to reach Odoo server at ${serverUrl}: ${message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private async handleHttpError(
    response: Response,
    model: string,
    method: string,
    db: string,
  ): Promise<never> {
    const errorDetails = await this.extractErrorPayload(response);

    this.logger.error(
      `Odoo API returned HTTP ${response.status} for ${model}/${method}: ${errorDetails}`,
    );

    if (response.status === 401 || response.status === 403) {
      throw new HttpException(
        `Unauthorized Odoo access: check API Key or database permissions for '${db}'. Details: ${errorDetails}`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (response.status === 404) {
      throw new HttpException(
        `Odoo model '${model}' or method '${method}' not found on database '${db}'`,
        HttpStatus.NOT_FOUND,
      );
    }

    throw new HttpException(
      `Odoo error (${response.status}): ${errorDetails}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private async extractErrorPayload(response: Response): Promise<string> {
    const body = await response.text();
    try {
      const errorJson: unknown = JSON.parse(body);
      return JSON.stringify(errorJson);
    } catch {
      return body;
    }
  }
}
