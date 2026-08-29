import { OdooTenantConfig } from '../odoo/odoo.types.js';

export interface TenantUser {
  id: string;
  externalPhone: string;
  name: string;
  role: 'admin' | 'sales_rep' | 'manager' | 'customer';
  tenantId: string;
}

export interface Tenant {
  id: string;
  name: string;
  odooConfig: OdooTenantConfig;
  isActive: boolean;
}

export interface TenantResolver {
  resolveBySenderId(senderId: string, channel: string): Promise<{ tenant: Tenant; user: TenantUser } | null>;
}
