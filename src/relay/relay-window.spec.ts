import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RelayStore } from './relay.store.js';

describe('RelayStore operator window tracking and unnotified consultations', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(new ConfigService({ RELAY_DB_PATH: ':memory:' }));
    store.onModuleInit();
  });

  afterEach(() => {
    store.onApplicationShutdown();
  });

  it('records operator activity and clears previous warning timestamp', () => {
    const t1 = 1_000_000;
    store.recordOperatorActivity(t1);
    expect(store.getLastOperatorInboundAt()).toBe(t1);

    store.recordOperatorWindowWarningSent(t1 + 500);
    expect(store.getOperatorWindowWarningSentAt()).toBe(t1 + 500);

    const t2 = 2_000_000;
    store.recordOperatorActivity(t2);
    expect(store.getLastOperatorInboundAt()).toBe(t2);
    expect(store.getOperatorWindowWarningSentAt()).toBeUndefined();
  });

  it('correctly evaluates isOperatorWindowExpiring based on 23h-24h threshold', () => {
    expect(store.isOperatorWindowExpiring(Date.now())).toBe(false);

    const base = 10_000_000;
    store.recordOperatorActivity(base);

    const twentyTwoHours = 22 * 60 * 60 * 1000;
    const twentyThreeHours = 23 * 60 * 60 * 1000;
    const twentyThreeAndHalfHours = 23.5 * 60 * 60 * 1000;
    const twentyFourHours = 24 * 60 * 60 * 1000;

    // At 22 hours: not expiring yet
    expect(store.isOperatorWindowExpiring(base + twentyTwoHours)).toBe(false);

    // At 23 hours: expiring!
    expect(store.isOperatorWindowExpiring(base + twentyThreeHours)).toBe(true);

    // At 23.5 hours before warning sent: still expiring
    expect(
      store.isOperatorWindowExpiring(base + twentyThreeAndHalfHours),
    ).toBe(true);

    // Warning sent at 23.5 hours
    store.recordOperatorWindowWarningSent(base + twentyThreeAndHalfHours);
    // Same cycle: should not send another warning
    expect(
      store.isOperatorWindowExpiring(base + twentyThreeAndHalfHours + 1000),
    ).toBe(false);

    // At 24 hours (already closed): should not send session warning
    expect(store.isOperatorWindowExpiring(base + twentyFourHours)).toBe(false);
  });

  it('retrieves unnotified consultations in notify_failed or notify_unknown status', () => {
    const id1 = store.createConsultation({
      customerWaId: 'c1',
      customerName: 'Julio',
      customerMessageId: 'm1',
      lastCustomerMessageId: 'm1',
      question: 'Demo por favor',
    });
    store.recordNotificationFailed(id1, 'notify_failed', 'HTTP 422');

    const id2 = store.createConsultation({
      customerWaId: 'c2',
      customerName: 'Juan',
      customerMessageId: 'm2',
      lastCustomerMessageId: 'm2',
      question: 'Deseo contratar',
    });
    store.recordNotificationFailed(id2, 'notify_unknown', 'timeout');

    const id3 = store.createConsultation({
      customerWaId: 'c3',
      customerName: 'Pedro',
      customerMessageId: 'm3',
      lastCustomerMessageId: 'm3',
      question: 'Hola',
    });
    store.recordNotificationSent(id3, 'notif3');

    const unnotified = store.getUnnotifiedConsultations();
    expect(unnotified).toHaveLength(2);
    expect(unnotified.map((c) => c.id)).toEqual([id1, id2]);
  });

  it('includes notify_failed and notify_unknown in getOpenConsultations', () => {
    const id1 = store.createConsultation({
      customerWaId: 'c1',
      customerName: 'Julio',
      customerMessageId: 'm1',
      lastCustomerMessageId: 'm1',
      question: 'Demo por favor',
    });
    store.recordNotificationFailed(id1, 'notify_failed', 'HTTP 422');

    const id2 = store.createConsultation({
      customerWaId: 'c2',
      customerName: 'Pedro',
      customerMessageId: 'm2',
      lastCustomerMessageId: 'm2',
      question: 'Hola',
    });
    store.recordNotificationSent(id2, 'notif2');

    const open = store.getOpenConsultations();
    expect(open).toHaveLength(2);
    expect(open.map((c) => c.id)).toEqual([id1, id2]);
  });

  it('includes notify_failed in getLatestOpenConsultation and allows claimForReply', () => {
    const id = store.createConsultation({
      customerWaId: 'c1',
      customerName: 'Julio',
      customerMessageId: 'm1',
      lastCustomerMessageId: 'm1',
      question: 'Demo por favor',
    });
    store.recordNotificationFailed(id, 'notify_failed', 'HTTP 422');

    const latest = store.getLatestOpenConsultation();
    expect(latest).toBeDefined();
    expect(latest?.id).toBe(id);

    expect(store.claimForReply(id)).toBe(true);
    expect(store.getStatus(id)).toBe('replying');
  });
});
