import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
  customerMessageId: string;
  status: ConsultationStatus;
}

interface ConsultationRow {
  id: number;
  customer_wa_id: string;
  customer_message_id: string;
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
`;

@Injectable()
export class RelayStore implements OnModuleInit, OnModuleDestroy {
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
  }

  onModuleDestroy() {
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
    question: string;
  }): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        `INSERT INTO consultations
           (customer_wa_id, customer_name, customer_message_id, question, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'notifying', ?, ?)`,
      )
      .run(
        input.customerWaId,
        input.customerName ?? null,
        input.customerMessageId,
        input.question,
        timestamp,
        timestamp,
      );
    return Number(result.lastInsertRowid);
  }

  findByNotification(notificationMessageId: string): Consultation | undefined {
    const row = this.db
      .prepare(
        'SELECT id, customer_wa_id, customer_message_id, status FROM consultations WHERE notification_message_id = ?',
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

  recordNotification(
    id: number,
    status: ConsultationStatus,
    notificationMessageId?: string,
    error?: string,
  ) {
    this.db
      .prepare(
        'UPDATE consultations SET status = ?, notification_message_id = ?, last_error = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, notificationMessageId ?? null, error ?? null, now(), id);
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
}

function toConsultation(row: ConsultationRow): Consultation {
  return {
    id: row.id,
    customerWaId: row.customer_wa_id,
    customerMessageId: row.customer_message_id,
    status: row.status,
  };
}

function now(): string {
  return new Date().toISOString();
}
