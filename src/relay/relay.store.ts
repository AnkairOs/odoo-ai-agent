import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboundMessage, isInboundMessage } from './kapso-payload.js';
import { z } from 'zod';
import {
  conversationProductSchema, costSchema, newProductSchema, salePriceSchema, sameProductDestination, taxIdSchema,
  type ConversationProduct, type NewProduct, type ProductDestination,
} from '../odoo/odoo-product-creation.service.js';
import { saleTaxSchema } from '../odoo/odoo-taxes.service.js';
import type { ModelMessage } from 'ai';

const conversationPriceSchema = z.object({
  amount: salePriceSchema,
  includesTax: z.boolean(),
  requestedTaxId: taxIdSchema.optional(),
  tax: saleTaxSchema,
  listPrice: salePriceSchema,
}).strict();
export type ConversationPrice = z.infer<typeof conversationPriceSchema>;

const catalogText = /^[\p{L}\p{N}][\p{L}\p{N} ._()+&,'’#-]*$/u;

export const conversationProductIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const updateCurrentValuesSchema = z.object({
  name: z.string().min(1),
  reference: z.string().optional(),
  listPrice: z.number().min(0).optional(),
  cost: z.number().min(0).optional(),
  taxId: taxIdSchema.optional(),
}).strict();
export type ConversationCurrentValues = z.infer<typeof updateCurrentValuesSchema>;

export const updateProposedValuesSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(catalogText).optional(),
  reference: z.string().trim().min(1).max(255).regex(catalogText).optional(),
  price: conversationPriceSchema.optional(),
  cost: costSchema.optional(),
}).strict().refine(
  (data) => data.name !== undefined || data.reference !== undefined || data.price !== undefined || data.cost !== undefined,
  { message: 'At least one proposed value must be provided' },
);
export type ConversationProposedValues = z.infer<typeof updateProposedValuesSchema>;

export const conversationProductUpdateInputSchema = z.object({
  productId: conversationProductIdSchema,
  name: z.string().trim().min(1).max(120).regex(catalogText).optional(),
  reference: z.string().trim().min(1).max(255).regex(catalogText).optional(),
  salePrice: salePriceSchema.optional(),
  priceIncludesTax: z.boolean().optional(),
  taxId: taxIdSchema.optional(),
  cost: costSchema.optional(),
}).strict().refine(
  (data) =>
    data.name !== undefined ||
    data.reference !== undefined ||
    data.salePrice !== undefined ||
    data.cost !== undefined ||
    data.taxId !== undefined,
  { message: 'At least one field must be provided' },
);
export type ConversationProductUpdateInput = z.infer<typeof conversationProductUpdateInputSchema>;

export const conversationProductArchiveInputSchema = z.object({
  productId: conversationProductIdSchema,
}).strict();
export type ConversationProductArchiveInput = z.infer<typeof conversationProductArchiveInputSchema>;

export const conversationCreateBatchItemSchema = newProductSchema.extend({
  price: conversationPriceSchema.optional(),
  cost: costSchema.optional(),
}).strict();
export type ConversationCreateBatchItem = z.infer<typeof conversationCreateBatchItemSchema>;

export const conversationCreateBatchPayloadSchema = z.object({
  items: z.array(conversationProductSchema).min(2).max(20),
}).strict();
export type ConversationCreateBatchPayload = z.infer<typeof conversationCreateBatchPayloadSchema>;

export const conversationUpdateBatchItemSchema = z.object({
  productId: conversationProductIdSchema,
  currentValues: updateCurrentValuesSchema,
  proposedValues: updateProposedValuesSchema,
}).strict();
export type ConversationUpdateBatchItem = z.infer<typeof conversationUpdateBatchItemSchema>;

export const conversationUpdateBatchPayloadSchema = z.object({
  items: z.array(conversationProductUpdateInputSchema).min(2).max(20).refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
    { message: 'Product IDs must be unique' },
  ),
}).strict();
export type ConversationUpdateBatchPayload = z.infer<typeof conversationUpdateBatchPayloadSchema>;

export const conversationArchiveBatchItemSchema = z.object({
  productId: conversationProductIdSchema,
  name: z.string().min(1),
  reference: z.string().optional(),
}).strict();
export type ConversationArchiveBatchItem = z.infer<typeof conversationArchiveBatchItemSchema>;

export const conversationArchiveBatchPayloadSchema = z.object({
  items: z.array(conversationProductArchiveInputSchema).min(2).max(50).refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
    { message: 'Product IDs must be unique' },
  ),
}).strict();
export type ConversationArchiveBatchPayload = z.infer<typeof conversationArchiveBatchPayloadSchema>;

export const conversationBatchOutcomeSchema = z.object({
  completedProductIds: z.array(conversationProductIdSchema),
  uncertainProductIds: z.array(conversationProductIdSchema),
}).strict();
export type ConversationBatchOutcome = z.infer<typeof conversationBatchOutcomeSchema>;

interface ConversationActionBase extends ProductDestination {
  id: string;
  approvalId: string;
  authorityFingerprint: string;
  toolCallId: string;
  expiresAt: number;
  status: 'proposed' | 'pending' | 'approved' | 'creating' | 'created' | 'cancelled' | 'rejected' | 'unknown';
  visibleMessageId?: string;
  productId?: number;
}

export interface ConversationCreateAction extends ConversationActionBase, NewProduct {
  kind?: 'create';
  price?: ConversationPrice;
  cost?: number;
}

export interface ConversationUpdateAction extends ConversationActionBase {
  kind: 'update';
  productId: number;
  currentValues: ConversationCurrentValues;
  proposedValues: ConversationProposedValues;
}

export interface ConversationArchiveAction extends ConversationActionBase {
  kind: 'archive';
  productId: number;
  name: string;
  reference?: string;
}

export interface ConversationCreateBatchAction extends ConversationActionBase {
  kind: 'create_batch';
  items: ConversationCreateBatchItem[];
  outcome?: ConversationBatchOutcome;
}

export interface ConversationUpdateBatchAction extends ConversationActionBase {
  kind: 'update_batch';
  items: ConversationUpdateBatchItem[];
  outcome?: ConversationBatchOutcome;
}

export interface ConversationArchiveBatchAction extends ConversationActionBase {
  kind: 'archive_batch';
  items: ConversationArchiveBatchItem[];
  outcome?: ConversationBatchOutcome;
}

export type ConversationAction =
  | ConversationCreateAction
  | ConversationUpdateAction
  | ConversationArchiveAction
  | ConversationCreateBatchAction
  | ConversationUpdateBatchAction
  | ConversationArchiveBatchAction;

export type ConversationActionProposal =
  | (Omit<ConversationCreateAction, 'status' | 'visibleMessageId' | 'productId'> & { kind?: 'create'; productId?: number })
  | (Omit<ConversationUpdateAction, 'status' | 'visibleMessageId'> & { kind: 'update' })
  | (Omit<ConversationArchiveAction, 'status' | 'visibleMessageId'> & { kind: 'archive' })
  | (Omit<ConversationCreateBatchAction, 'status' | 'visibleMessageId' | 'outcome'> & { kind: 'create_batch' })
  | (Omit<ConversationUpdateBatchAction, 'status' | 'visibleMessageId' | 'outcome'> & { kind: 'update_batch' })
  | (Omit<ConversationArchiveBatchAction, 'status' | 'visibleMessageId' | 'outcome'> & { kind: 'archive_batch' });

export interface OperatorConversation {
  messages: ModelMessage[];
  action?: ConversationAction;
  busy?: string;
}

export const MAX_CONVERSATION_MESSAGES = 40;
export const MAX_CONVERSATION_BYTES = 64_000;

const APPROVAL_TOOLS = [
  'create_product',
  'update_product',
  'archive_product',
  'create_products',
  'update_products',
  'archive_products',
] as const;

function isBatchAction(action: ConversationAction): action is
  | ConversationCreateBatchAction
  | ConversationUpdateBatchAction
  | ConversationArchiveBatchAction {
  return action.kind === 'create_batch' || action.kind === 'update_batch' || action.kind === 'archive_batch';
}

function hasApprovalChain(messages: ModelMessage[], approvalId: string, toolCallId: string, toolName?: string): boolean {
  const allowed = toolName ? [toolName] : APPROVAL_TOOLS;
  return messages.some((message) => message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'tool-approval-request' && part.approvalId === approvalId &&
      part.toolCallId === toolCallId) && message.content.some((part) => part.type === 'tool-call' &&
        part.toolCallId === toolCallId && typeof part.toolName === 'string' && (allowed as readonly string[]).includes(part.toolName)));
}

function matchesCreateBatchItem(item: ConversationCreateBatchItem, input: ConversationProduct): boolean {
  return item.name === input.name &&
    item.reference === input.reference &&
    item.price?.amount === input.salePrice &&
    item.price?.includesTax === input.priceIncludesTax &&
    item.price?.requestedTaxId === input.taxId &&
    item.cost === input.cost;
}

function matchesUpdateBatchItem(item: ConversationUpdateBatchItem, input: ConversationProductUpdateInput): boolean {
  if (item.productId !== input.productId) return false;
  const proposed = item.proposedValues;
  if (proposed.name !== input.name) return false;
  if (proposed.reference !== input.reference) return false;
  if (proposed.cost !== input.cost) return false;
  if (proposed.price) {
    if (proposed.price.amount !== input.salePrice) return false;
    if (proposed.price.includesTax !== input.priceIncludesTax) return false;
    if (proposed.price.requestedTaxId !== input.taxId) return false;
  } else {
    if (input.salePrice !== undefined || input.priceIncludesTax !== undefined || input.taxId !== undefined) return false;
  }
  return true;
}

function matchesArchiveBatchItem(item: ConversationArchiveBatchItem, input: ConversationProductArchiveInput): boolean {
  return item.productId === input.productId;
}

function matchesBatchPayload(
  action:
    | { kind: 'create_batch'; items: ConversationCreateBatchItem[] }
    | { kind: 'update_batch'; items: ConversationUpdateBatchItem[] }
    | { kind: 'archive_batch'; items: ConversationArchiveBatchItem[] },
  payload: unknown,
): boolean {
  if (action.kind === 'create_batch') {
    const parsed = conversationCreateBatchPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.items.length !== action.items.length) return false;
    return action.items.every((item, i) => matchesCreateBatchItem(item, parsed.data.items[i]));
  }
  if (action.kind === 'update_batch') {
    const parsed = conversationUpdateBatchPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.items.length !== action.items.length) return false;
    return action.items.every((item, i) => matchesUpdateBatchItem(item, parsed.data.items[i]));
  }
  if (action.kind === 'archive_batch') {
    const parsed = conversationArchiveBatchPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.items.length !== action.items.length) return false;
    return action.items.every((item, i) => matchesArchiveBatchItem(item, parsed.data.items[i]));
  }
  return false;
}

function findToolCallInput(messages: ModelMessage[], toolCallId: string, toolName: string): unknown | undefined {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call' && part.toolCallId === toolCallId && part.toolName === toolName) {
          return part.input;
        }
      }
    }
  }
  return undefined;
}

function matchesBatchActionHistory(
  messages: ModelMessage[],
  action: ConversationCreateBatchAction | ConversationUpdateBatchAction | ConversationArchiveBatchAction,
): boolean {
  const toolName = action.kind === 'create_batch' ? 'create_products'
    : action.kind === 'update_batch' ? 'update_products' : 'archive_products';
  const input = findToolCallInput(messages, action.toolCallId, toolName);
  return input !== undefined && matchesBatchPayload(action, input);
}

function matchesRequest(action: ConversationCreateAction, input: ConversationProduct): boolean {
  return action.name === input.name && action.reference === input.reference &&
    action.price?.amount === input.salePrice && action.price?.includesTax === input.priceIncludesTax &&
    action.price?.requestedTaxId === input.taxId && action.cost === input.cost;
}

function matchesUpdateRequest(action: ConversationUpdateAction, input: ConversationProductUpdateInput): boolean {
  if (action.productId !== input.productId) return false;
  const proposed = action.proposedValues;
  if (proposed.name !== input.name) return false;
  if (proposed.reference !== input.reference) return false;
  if (proposed.cost !== input.cost) return false;
  if (proposed.price) {
    if (proposed.price.amount !== input.salePrice) return false;
    if (proposed.price.includesTax !== input.priceIncludesTax) return false;
    if (proposed.price.requestedTaxId !== input.taxId) return false;
  } else {
    if (input.salePrice !== undefined || input.priceIncludesTax !== undefined || input.taxId !== undefined) return false;
  }
  return true;
}

export function boundConversation(messages: ModelMessage[]): ModelMessage[] | undefined {
  let start = 0;
  while (messages.length - start > MAX_CONVERSATION_MESSAGES ||
    Buffer.byteLength(JSON.stringify(messages.slice(start))) > MAX_CONVERSATION_BYTES) {
    const next = messages.findIndex((message, index) => index > start && message.role === 'user');
    if (next === -1) return undefined;
    start = next;
  }
  return messages.slice(start);
}

export interface ProductPreview extends NewProduct, ProductDestination {
  messageId: string;
  operator: string;
  businessPhone: string;
  expiresAt: number;
  status: 'pending' | 'creating' | 'created' | 'cancelled' | 'rejected' | 'unknown';
  productId?: number;
}

export type ConsultationStatus =
  | 'notifying'
  | 'notify_failed'
  | 'notify_unknown'
  | 'awaiting_reply'
  | 'replying'
  | 'replied'
  | 'reply_unknown';

export interface Consultation {
  id: number;
  customerWaId: string;
  lastCustomerMessageId: string;
  status: ConsultationStatus;
}

export interface NotifiedConsultation extends Consultation {
  suggestion?: string;
}

export interface PastConsultation {
  question: string;
  reply: string | null;
  date: string;
}

export interface PastAnswer {
  question: string;
  reply: string;
}

export interface RelayJob {
  id: number;
  tenantId: string;
  messages: InboundMessage[];
}

interface ConsultationRow {
  id: number;
  customer_wa_id: string;
  last_customer_message_id: string;
  status: ConsultationStatus;
}

const DEFAULT_DB_PATH = 'data/relay.sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS operator_conversations (
    operator TEXT NOT NULL,
    business_phone TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    action TEXT,
    busy TEXT,
    PRIMARY KEY (operator, business_phone)
  );
  CREATE TABLE IF NOT EXISTS operator_conversation_events (
    operator TEXT NOT NULL,
    business_phone TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (operator, business_phone, event_id)
  );
  CREATE TABLE IF NOT EXISTS operator_product_previews (
    message_id TEXT PRIMARY KEY,
    proposal_event_id TEXT NOT NULL UNIQUE,
    operator TEXT NOT NULL,
    business_phone TEXT NOT NULL,
    name TEXT NOT NULL,
    reference TEXT,
    url TEXT NOT NULL,
    db TEXT NOT NULL,
    company_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    product_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_wa_id TEXT NOT NULL,
    customer_name TEXT,
    customer_message_id TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL,
    notification_message_id TEXT UNIQUE,
    reply_message_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS consultation_notifications (
    message_id TEXT PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES consultations (id)
  );
  INSERT OR IGNORE INTO consultation_notifications (message_id, consultation_id)
    SELECT notification_message_id, id FROM consultations WHERE notification_message_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS relay_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS relay_jobs_status ON relay_jobs (status, id);
`;

const OPEN_STATUSES =
  "('notifying', 'notify_failed', 'notify_unknown', 'awaiting_reply')";
const UNNOTIFIED_STATUSES = "('notifying', 'notify_failed', 'notify_unknown')";

const MAX_JOB_ATTEMPTS = 3;
const PAST_RESULTS_LIMIT = 5;

@Injectable()
export class RelayStore implements OnModuleInit, OnApplicationShutdown {
  private db: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const path =
      this.configService.get<string>('RELAY_DB_PATH') || DEFAULT_DB_PATH;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.addLastCustomerMessageColumn();
    this.addColumnIfMissing('consultations', 'reply_text');
    this.addColumnIfMissing('consultation_notifications', 'suggestion');
  }

  private addLastCustomerMessageColumn() {
    if (this.hasColumn('consultations', 'last_customer_message_id')) {
      return;
    }
    this.db.exec(`
      ALTER TABLE consultations ADD COLUMN last_customer_message_id TEXT;
      UPDATE consultations SET last_customer_message_id = customer_message_id;
    `);
  }

  private addColumnIfMissing(table: string, column: string) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return columns.some((c) => c.name === column);
  }

  onApplicationShutdown() {
    this.db?.close();
  }

  markProcessed(messageId: string): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)',
      )
      .run(messageId, now());
    return result.changes === 1;
  }

  getOperatorConversation(operator: string, businessPhone: string): OperatorConversation {
    const row = this.db.prepare(`SELECT messages, action, busy FROM operator_conversations
      WHERE operator = ? AND business_phone = ?`).get(operator, businessPhone) as
      { messages: string; action: string | null; busy: string | null } | undefined;
    return row ? { messages: JSON.parse(row.messages) as ModelMessage[],
      action: row.action ? JSON.parse(row.action) as ConversationAction : undefined,
      busy: row.busy ?? undefined } : { messages: [] };
  }

  claimConversationTurn(operator: string, businessPhone: string, eventId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO operator_conversations (operator, business_phone)
        VALUES (?, ?)`).run(operator, businessPhone);
      const locked = this.db.prepare(`UPDATE operator_conversations SET busy = ?
        WHERE operator = ? AND business_phone = ? AND busy IS NULL`).run(eventId, operator, businessPhone);
      const fresh = locked.changes === 1 && this.db.prepare(`INSERT OR IGNORE INTO operator_conversation_events
        (operator, business_phone, event_id) VALUES (?, ?, ?)`).run(operator, businessPhone, eventId).changes === 1;
      this.db.exec(fresh ? 'COMMIT' : 'ROLLBACK');
      return fresh;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseConversationTurn(operator: string, businessPhone: string, eventId: string): void {
    this.db.prepare(`UPDATE operator_conversations SET busy = NULL
      WHERE operator = ? AND business_phone = ? AND busy = ?`).run(operator, businessPhone, eventId);
  }

  saveConversationMessages(operator: string, businessPhone: string, eventId: string, messages: ModelMessage[]): boolean {
    const state = this.getOperatorConversation(operator, businessPhone);
    if (state.busy !== eventId) return false;
    const bounded = boundConversation(messages);
    if (!bounded) return false;
    // An unresolved native approval chain must never be partially pruned.
    if (state.action && ['proposed', 'pending', 'approved', 'creating', 'unknown'].includes(state.action.status)) {
      if (!hasApprovalChain(bounded, state.action.approvalId, state.action.toolCallId)) return false;
      if (isBatchAction(state.action) && !matchesBatchActionHistory(bounded, state.action)) return false;
    }
    return this.db.prepare(`UPDATE operator_conversations SET messages = ?
      WHERE operator = ? AND business_phone = ? AND busy = ?`)
      .run(JSON.stringify(bounded), operator, businessPhone, eventId).changes === 1;
  }

  reserveConversationAction(operator: string, businessPhone: string, eventId: string,
    action: ConversationActionProposal, messages: ModelMessage[]): boolean {
    const state = this.getOperatorConversation(operator, businessPhone);
    if (state.busy !== eventId ||
      (state.action && !['created', 'cancelled', 'rejected'].includes(state.action.status))) return false;
    const bounded = boundConversation(messages);
    if (!bounded) return false;

    if (action.kind === 'create_batch') {
      if (!Array.isArray(action.items) || action.items.length < 2 || action.items.length > 20) return false;
      const parsedItems: ConversationCreateBatchItem[] = [];
      for (const item of action.items) {
        const res = conversationCreateBatchItemSchema.safeParse(item);
        if (!res.success) return false;
        parsedItems.push(res.data);
      }
      if (!hasApprovalChain(bounded, action.approvalId, action.toolCallId, 'create_products')) return false;
      const input = findToolCallInput(bounded, action.toolCallId, 'create_products');
      if (input === undefined || !matchesBatchPayload({ kind: 'create_batch', items: parsedItems }, input)) return false;
      const stored: ConversationCreateBatchAction = {
        ...action,
        kind: 'create_batch',
        items: parsedItems,
        status: 'proposed',
      };
      return this.db.prepare(`UPDATE operator_conversations SET action = ?, messages = ?
        WHERE operator = ? AND business_phone = ? AND busy = ?`).run(
          JSON.stringify(stored), JSON.stringify(bounded), operator, businessPhone, eventId).changes === 1;
    }

    if (action.kind === 'update_batch') {
      if (!Array.isArray(action.items) || action.items.length < 2 || action.items.length > 20) return false;
      const parsedItems: ConversationUpdateBatchItem[] = [];
      const ids: number[] = [];
      for (const item of action.items) {
        const res = conversationUpdateBatchItemSchema.safeParse(item);
        if (!res.success) return false;
        parsedItems.push(res.data);
        ids.push(res.data.productId);
      }
      if (new Set(ids).size !== ids.length) return false;
      if (!hasApprovalChain(bounded, action.approvalId, action.toolCallId, 'update_products')) return false;
      const input = findToolCallInput(bounded, action.toolCallId, 'update_products');
      if (input === undefined || !matchesBatchPayload({ kind: 'update_batch', items: parsedItems }, input)) return false;
      const stored: ConversationUpdateBatchAction = {
        ...action,
        kind: 'update_batch',
        items: parsedItems,
        status: 'proposed',
      };
      return this.db.prepare(`UPDATE operator_conversations SET action = ?, messages = ?
        WHERE operator = ? AND business_phone = ? AND busy = ?`).run(
          JSON.stringify(stored), JSON.stringify(bounded), operator, businessPhone, eventId).changes === 1;
    }

    if (action.kind === 'archive_batch') {
      if (!Array.isArray(action.items) || action.items.length < 2 || action.items.length > 50) return false;
      const parsedItems: ConversationArchiveBatchItem[] = [];
      const ids: number[] = [];
      for (const item of action.items) {
        const res = conversationArchiveBatchItemSchema.safeParse(item);
        if (!res.success) return false;
        parsedItems.push(res.data);
        ids.push(res.data.productId);
      }
      if (new Set(ids).size !== ids.length) return false;
      if (!hasApprovalChain(bounded, action.approvalId, action.toolCallId, 'archive_products')) return false;
      const input = findToolCallInput(bounded, action.toolCallId, 'archive_products');
      if (input === undefined || !matchesBatchPayload({ kind: 'archive_batch', items: parsedItems }, input)) return false;
      const stored: ConversationArchiveBatchAction = {
        ...action,
        kind: 'archive_batch',
        items: parsedItems,
        status: 'proposed',
      };
      return this.db.prepare(`UPDATE operator_conversations SET action = ?, messages = ?
        WHERE operator = ? AND business_phone = ? AND busy = ?`).run(
          JSON.stringify(stored), JSON.stringify(bounded), operator, businessPhone, eventId).changes === 1;
    }

    if (action.kind === 'update') {
      const idParsed = conversationProductIdSchema.safeParse(action.productId);
      const current = updateCurrentValuesSchema.safeParse(action.currentValues);
      const proposed = updateProposedValuesSchema.safeParse(action.proposedValues);
      if (!idParsed.success || !current.success || !proposed.success ||
        !hasApprovalChain(bounded, action.approvalId, action.toolCallId, 'update_product')) return false;
      const stored: ConversationUpdateAction = {
        ...action,
        kind: 'update',
        productId: idParsed.data,
        currentValues: current.data,
        proposedValues: proposed.data,
        status: 'proposed',
      };
      return this.db.prepare(`UPDATE operator_conversations SET action = ?, messages = ?
        WHERE operator = ? AND business_phone = ? AND busy = ?`).run(
          JSON.stringify(stored), JSON.stringify(bounded), operator, businessPhone, eventId).changes === 1;
    }

    if (action.kind === 'archive') {
      const idParsed = conversationProductIdSchema.safeParse(action.productId);
      const nameParsed = z.string().min(1).safeParse(action.name);
      const refParsed = z.string().optional().safeParse(action.reference);
      if (!idParsed.success || !nameParsed.success || !refParsed.success ||
        !hasApprovalChain(bounded, action.approvalId, action.toolCallId, 'archive_product')) return false;
      const stored: ConversationArchiveAction = {
        ...action,
        kind: 'archive',
        productId: idParsed.data,
        name: nameParsed.data,
        ...(action.reference !== undefined ? { reference: action.reference } : {}),
        status: 'proposed',
      };
      return this.db.prepare(`UPDATE operator_conversations SET action = ?, messages = ?
        WHERE operator = ? AND business_phone = ? AND busy = ?`).run(
          JSON.stringify(stored), JSON.stringify(bounded), operator, businessPhone, eventId).changes === 1;
    }

    const product = newProductSchema.safeParse({ name: action.name,
      ...(action.reference === undefined ? {} : { reference: action.reference }) });
    const price = conversationPriceSchema.optional().safeParse(action.price);
    const cost = costSchema.optional().safeParse(action.cost);
    if (!product.success || !price.success || !cost.success ||
      !hasApprovalChain(bounded, action.approvalId, action.toolCallId, 'create_product')) return false;
    const stored: ConversationCreateAction = {
      ...action,
      kind: 'create',
      ...product.data,
      status: 'proposed',
    };
    return this.db.prepare(`UPDATE operator_conversations SET action = ?, messages = ?
      WHERE operator = ? AND business_phone = ? AND busy = ?`).run(
        JSON.stringify(stored), JSON.stringify(bounded),
        operator, businessPhone, eventId).changes === 1;
  }

  bindConversationPreview(operator: string, businessPhone: string, eventId: string, actionId: string, messageId: string): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      action.status === 'proposed' && messageId ? { ...action, status: 'pending', visibleMessageId: messageId } : undefined);
  }

  cancelConversationAction(operator: string, businessPhone: string, eventId: string, actionId: string): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      ['proposed', 'pending'].includes(action.status) ? { ...action, status: 'cancelled' } : undefined);
  }

  authorizeConversationAction(operator: string, businessPhone: string, eventId: string, actionId: string,
    target: ProductDestination, timestamp: number): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      action.status === 'pending' && action.visibleMessageId && action.expiresAt > timestamp &&
        sameProductDestination(action, target) ? { ...action, status: 'approved' } : undefined);
  }

  claimConversationCreation(operator: string, businessPhone: string, eventId: string, actionId: string,
    toolCallId: string, input: ConversationProduct, target: ProductDestination, timestamp: number): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      conversationProductSchema.safeParse(input).success &&
      (action.kind === undefined || action.kind === 'create') &&
      action.status === 'approved' && action.visibleMessageId && action.expiresAt > timestamp &&
      action.toolCallId === toolCallId && matchesRequest(action, input) &&
      sameProductDestination(action, target) ? { ...action, status: 'creating' } : undefined);
  }

  claimConversationUpdate(operator: string, businessPhone: string, eventId: string, actionId: string,
    toolCallId: string, input: ConversationProductUpdateInput, target: ProductDestination, timestamp: number): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      conversationProductUpdateInputSchema.safeParse(input).success &&
      action.kind === 'update' &&
      action.status === 'approved' && action.visibleMessageId && action.expiresAt > timestamp &&
      action.toolCallId === toolCallId && matchesUpdateRequest(action, input) &&
      sameProductDestination(action, target) ? { ...action, status: 'creating' } : undefined);
  }

  claimConversationArchive(operator: string, businessPhone: string, eventId: string, actionId: string,
    toolCallId: string, input: ConversationProductArchiveInput, target: ProductDestination, timestamp: number): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      conversationProductArchiveInputSchema.safeParse(input).success &&
      action.kind === 'archive' &&
      action.status === 'approved' && action.visibleMessageId && action.expiresAt > timestamp &&
      action.toolCallId === toolCallId && action.productId === input.productId &&
      sameProductDestination(action, target) ? { ...action, status: 'creating' } : undefined);
  }

  claimConversationBatch(operator: string, businessPhone: string, eventId: string, actionId: string,
    toolCallId: string, payload: unknown, target: ProductDestination, timestamp: number): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) =>
      isBatchAction(action) &&
      action.status === 'approved' &&
      action.visibleMessageId &&
      action.expiresAt > timestamp &&
      action.toolCallId === toolCallId &&
      sameProductDestination(action, target) &&
      matchesBatchPayload(action, payload) ? { ...action, status: 'creating' } : undefined);
  }

  finishConversationAction(operator: string, businessPhone: string, eventId: string, actionId: string,
    status: 'created' | 'rejected' | 'unknown', productId?: number): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) => {
      if (action.status !== 'creating' || isBatchAction(action)) return undefined;
      if (status === 'created') {
        if (action.kind === 'update' || action.kind === 'archive') {
          return { ...action, status };
        }
        if (!Number.isSafeInteger(productId) || productId! <= 0) return undefined;
        return { ...action, status, productId };
      }
      return { ...action, status };
    });
  }

  finishConversationCreation(operator: string, businessPhone: string, eventId: string, actionId: string,
    status: 'created' | 'rejected' | 'unknown', productId?: number): boolean {
    return this.finishConversationAction(operator, businessPhone, eventId, actionId, status, productId);
  }

  finishConversationUpdate(operator: string, businessPhone: string, eventId: string, actionId: string,
    status: 'created' | 'rejected' | 'unknown'): boolean {
    return this.finishConversationAction(operator, businessPhone, eventId, actionId, status);
  }

  finishConversationArchive(operator: string, businessPhone: string, eventId: string, actionId: string,
    status: 'created' | 'rejected' | 'unknown'): boolean {
    return this.finishConversationAction(operator, businessPhone, eventId, actionId, status);
  }

  finishConversationBatch(operator: string, businessPhone: string, eventId: string, actionId: string,
    status: 'created' | 'rejected' | 'unknown', outcome: ConversationBatchOutcome): boolean {
    return this.updateConversationAction(operator, businessPhone, eventId, actionId, (action) => {
      if (!isBatchAction(action) || action.status !== 'creating') return undefined;
      const parsedOutcome = conversationBatchOutcomeSchema.safeParse(outcome);
      if (!parsedOutcome.success) return undefined;
      const cleanOutcome: ConversationBatchOutcome = {
        completedProductIds: [...parsedOutcome.data.completedProductIds],
        uncertainProductIds: [...parsedOutcome.data.uncertainProductIds],
      };
      if (status === 'created') {
        if (cleanOutcome.uncertainProductIds.length !== 0 ||
          cleanOutcome.completedProductIds.length !== action.items.length) {
          return undefined;
        }
        if (new Set(cleanOutcome.completedProductIds).size !== cleanOutcome.completedProductIds.length) {
          return undefined;
        }
        if (action.kind === 'update_batch' || action.kind === 'archive_batch') {
          const expectedIds = new Set(action.items.map((item) => item.productId));
          if (!cleanOutcome.completedProductIds.every((id) => expectedIds.has(id))) {
            return undefined;
          }
        }
      }
      return { ...action, status, outcome: cleanOutcome };
    });
  }

  private updateConversationAction(operator: string, businessPhone: string, eventId: string, actionId: string,
    update: (action: ConversationAction) => ConversationAction | undefined): boolean {
    const state = this.getOperatorConversation(operator, businessPhone);
    if (state.busy !== eventId || state.action?.id !== actionId) return false;
    const changed = update(state.action);
    if (!changed) return false;
    return this.db.prepare(`UPDATE operator_conversations SET action = ?
      WHERE operator = ? AND business_phone = ? AND busy = ? AND action = ?`)
      .run(JSON.stringify(changed), operator, businessPhone, eventId, JSON.stringify(state.action)).changes === 1;
  }

  recordProductPreview(preview: Omit<ProductPreview, 'status' | 'productId'>, proposalEventId: string): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO operator_product_previews
      (message_id, proposal_event_id, operator, business_phone, name, reference, url, db, company_id, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(preview.messageId, proposalEventId, preview.operator, preview.businessPhone,
        preview.name, preview.reference ?? null, preview.url, preview.db, preview.companyId, preview.expiresAt);
    return result.changes === 1;
  }

  findProductPreview(messageId: string): ProductPreview | undefined {
    const row = this.db.prepare(`SELECT message_id AS messageId, operator, business_phone AS businessPhone,
      name, reference, url, db, company_id AS companyId, expires_at AS expiresAt, status, product_id AS productId
      FROM operator_product_previews WHERE message_id = ?`).get(messageId) as
      (Omit<ProductPreview, 'reference' | 'productId'> & { reference: string | null; productId: number | null }) | undefined;
    return row ? { ...row, reference: row.reference ?? undefined, productId: row.productId ?? undefined } : undefined;
  }

  claimProductPreview(messageId: string, operator: string, businessPhone: string,
    target: ProductDestination, status: 'creating' | 'cancelled', timestamp: number): boolean {
    const result = this.db.prepare(`UPDATE operator_product_previews SET status = ?
      WHERE message_id = ? AND operator = ? AND business_phone = ? AND url = ? AND db = ?
      AND company_id = ? AND status = 'pending' AND expires_at > ?`)
      .run(status, messageId, operator, businessPhone, target.url, target.db, target.companyId, timestamp);
    return result.changes === 1;
  }

  finishProductCreation(messageId: string, status: 'created' | 'rejected' | 'unknown', productId?: number): void {
    this.db.prepare(`UPDATE operator_product_previews SET status = ?, product_id = ?
      WHERE message_id = ? AND status = 'creating'`).run(status, productId ?? null, messageId);
  }

  createConsultation(input: {
    customerWaId: string;
    customerName?: string;
    customerMessageId: string;
    lastCustomerMessageId: string;
    question: string;
  }): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        `INSERT INTO consultations
           (customer_wa_id, customer_name, customer_message_id, last_customer_message_id, question, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'notifying', ?, ?)`,
      )
      .run(
        input.customerWaId,
        input.customerName ?? null,
        input.customerMessageId,
        input.lastCustomerMessageId,
        input.question,
        timestamp,
        timestamp,
      );
    return Number(result.lastInsertRowid);
  }

  findOpenForCustomer(customerWaId: string): Consultation | undefined {
    const row = this.db
      .prepare(
        `SELECT id, customer_wa_id, last_customer_message_id, status FROM consultations
         WHERE customer_wa_id = ? AND status IN ${OPEN_STATUSES}
         ORDER BY id DESC LIMIT 1`,
      )
      .get(customerWaId) as ConsultationRow | undefined;
    return row && toConsultation(row);
  }

  appendQuestion(id: number, text: string, lastCustomerMessageId: string) {
    this.db
      .prepare(
        `UPDATE consultations
         SET question = question || char(10) || ?, last_customer_message_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(text, lastCustomerMessageId, now(), id);
  }

  getQuestion(id: number): string | undefined {
    const row = this.db
      .prepare('SELECT question FROM consultations WHERE id = ?')
      .get(id) as { question: string } | undefined;
    return row?.question;
  }

  findByNotification(
    notificationMessageId: string,
  ): NotifiedConsultation | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id, c.customer_wa_id, c.last_customer_message_id, c.status, n.suggestion
         FROM consultation_notifications n JOIN consultations c ON c.id = n.consultation_id
         WHERE n.message_id = ?`,
      )
      .get(notificationMessageId) as
      (ConsultationRow & { suggestion: string | null }) | undefined;
    return (
      row && {
        ...toConsultation(row),
        ...(row.suggestion === null ? {} : { suggestion: row.suggestion }),
      }
    );
  }

  isCurrentNotification(id: number, messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT message_id FROM consultation_notifications
         WHERE consultation_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(id) as { message_id: string } | undefined;
    return row?.message_id === messageId;
  }

  customerHistory(
    customerWaId: string,
    excludedId: number,
  ): PastConsultation[] {
    return this.db
      .prepare(
        `SELECT question, reply_text AS reply, created_at AS date FROM consultations
         WHERE customer_wa_id = ? AND id != ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        customerWaId,
        excludedId,
        PAST_RESULTS_LIMIT,
      ) as unknown as PastConsultation[];
  }

  searchPastAnswers(keywords: string[]): PastAnswer[] {
    if (keywords.length === 0) {
      return [];
    }
    const matches = keywords
      .map(
        () =>
          '(instr(lower(question), ?) > 0 OR instr(lower(reply_text), ?) > 0)',
      )
      .join(' OR ');
    return this.db
      .prepare(
        `SELECT question, reply_text AS reply FROM consultations
         WHERE status = 'replied' AND reply_text IS NOT NULL AND (${matches})
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        ...keywords.flatMap((keyword) => [keyword, keyword]),
        PAST_RESULTS_LIMIT,
      ) as unknown as PastAnswer[];
  }

  getStatus(id: number): ConsultationStatus | undefined {
    const row = this.db
      .prepare('SELECT status FROM consultations WHERE id = ?')
      .get(id) as { status: ConsultationStatus } | undefined;
    return row?.status;
  }

  recordNotificationSent(
    id: number,
    notificationMessageId: string,
    suggestion?: string,
  ) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO consultation_notifications (message_id, consultation_id, suggestion) VALUES (?, ?, ?)',
      )
      .run(notificationMessageId, id, suggestion ?? null);
    this.db
      .prepare(
        `UPDATE consultations SET status = 'awaiting_reply', last_error = NULL, updated_at = ?
         WHERE id = ? AND status IN ${UNNOTIFIED_STATUSES}`,
      )
      .run(now(), id);
  }

  recordNotificationFailed(
    id: number,
    status: 'notify_failed' | 'notify_unknown',
    error: string,
  ) {
    this.db
      .prepare(
        `UPDATE consultations SET status = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ${UNNOTIFIED_STATUSES}`,
      )
      .run(status, error, now(), id);
  }

  claimForReply(id: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE consultations SET status = 'replying', updated_at = ? WHERE id = ? AND status = 'awaiting_reply'",
      )
      .run(now(), id);
    return result.changes === 1;
  }

  recordReply(
    id: number,
    status: ConsultationStatus,
    replyMessageId?: string,
    error?: string,
  ) {
    this.db
      .prepare(
        'UPDATE consultations SET status = ?, reply_message_id = ?, last_error = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, replyMessageId ?? null, error ?? null, now(), id);
  }

  recordReplySent(id: number, replyMessageId: string, replyText: string) {
    this.db
      .prepare(
        "UPDATE consultations SET status = 'replied', reply_message_id = ?, reply_text = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(replyMessageId, replyText, now(), id);
  }

  enqueueJob(tenantId: string, messages: InboundMessage[]): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        `INSERT INTO relay_jobs (tenant_id, payload, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(tenantId, JSON.stringify(messages), timestamp, timestamp);
    return Number(result.lastInsertRowid);
  }

  claimNextJob(): RelayJob | undefined {
    for (;;) {
      const row = this.claimNextJobRow();
      if (!row) {
        return undefined;
      }
      const messages = decodeMessages(row.payload);
      if (messages) {
        return { id: row.id, tenantId: row.tenant_id, messages };
      }
      this.failJob(row.id, 'invalid payload');
    }
  }

  private claimNextJobRow(): JobRow | undefined {
    return this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
         WHERE id = (SELECT id FROM relay_jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
         RETURNING id, tenant_id, payload`,
      )
      .get(now()) as JobRow | undefined;
  }

  completeJob(id: number) {
    this.db
      .prepare(
        "UPDATE relay_jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now(), id);
  }

  failJob(id: number, error: string) {
    this.db
      .prepare(
        "UPDATE relay_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(error, now(), id);
  }

  resumeInterruptedJobs() {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'failed', last_error = 'interrupted too many times', updated_at = ?
         WHERE status = 'processing' AND attempts >= ?`,
      )
      .run(timestamp, MAX_JOB_ATTEMPTS);
    this.db
      .prepare(
        "UPDATE relay_jobs SET status = 'pending', updated_at = ? WHERE status = 'processing'",
      )
      .run(timestamp);
  }
}

interface JobRow {
  id: number;
  tenant_id: string;
  payload: string;
}

function decodeMessages(payload: string): InboundMessage[] | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    return Array.isArray(value) && value.every(isInboundMessage)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function toConsultation(row: ConsultationRow): Consultation {
  return {
    id: row.id,
    customerWaId: row.customer_wa_id,
    lastCustomerMessageId: row.last_customer_message_id,
    status: row.status,
  };
}

function now(): string {
  return new Date().toISOString();
}
