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
  }

  private addLastCustomerMessageColumn() {
    const columns = this.db
      .prepare('PRAGMA table_info(consultations)')
      .all() as { name: string }[];
    if (columns.some((c) => c.name === 'last_customer_message_id')) {
      return;
    }
    this.db.exec(`
      ALTER TABLE consultations ADD COLUMN last_customer_message_id TEXT;
      UPDATE consultations SET last_customer_message_id = customer_message_id;
    `);
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

  findByNotification(notificationMessageId: string): Consultation | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id, c.customer_wa_id, c.last_customer_message_id, c.status
         FROM consultation_notifications n JOIN consultations c ON c.id = n.consultation_id
         WHERE n.message_id = ?`,
      )
      .get(notificationMessageId) as ConsultationRow | undefined;
    return row && toConsultation(row);
  }

  getStatus(id: number): ConsultationStatus | undefined {
    const row = this.db
      .prepare('SELECT status FROM consultations WHERE id = ?')
      .get(id) as { status: ConsultationStatus } | undefined;
    return row?.status;
  }

  recordNotificationSent(id: number, notificationMessageId: string) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO consultation_notifications (message_id, consultation_id) VALUES (?, ?)',
      )
      .run(notificationMessageId, id);
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
