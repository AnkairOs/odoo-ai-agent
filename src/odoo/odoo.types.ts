export interface OdooTenantConfig {
  url: string;
  db: string;
  apiKey: string;
  username?: string;
}

export interface OdooProduct {
  id: number;
  name: string;
  defaultCode?: string;
  listPrice: number;
  qtyAvailable: number;
  uomName?: string;
}

export interface OdooCustomer {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  vat?: string;
}

export interface OdooOrderLineInput {
  productId: number;
  quantity: number;
  unitPrice?: number;
}

export interface OdooQuotationInput {
  partnerId: number;
  orderLines: OdooOrderLineInput[];
  notes?: string;
}

export interface OdooSaleOrder {
  id: number;
  name: string;
  partnerId: number;
  partnerName: string;
  amountTotal: number;
  state: 'draft' | 'sent' | 'sale' | 'done' | 'cancel';
  createdAt: string;
}
