import { ConfigService } from '@nestjs/config';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayStore, type ConversationAction } from './relay.store.js';

const target = { url: 'https://odoo.test', db: 'catalog', companyId: 7 };
const proposed: Omit<ConversationAction, 'status'> = { ...target, id: 'action-1', name: 'Pioneer', reference: 'DDJ',
  toolCallId: 'call-1', approvalId: 'approval-1', authorityFingerprint: 'test-fingerprint', expiresAt: 5000 };
const history: ModelMessage[] = [{ role: 'user', content: 'Crea Pioneer' }, { role: 'assistant', content: [
  { type: 'tool-call', toolName: 'create_product', toolCallId: 'call-1', input: { name: 'Pioneer', reference: 'DDJ' } },
  { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' },
] }];

describe('durable operator conversation public store contract', () => {
  let store: RelayStore;
  const state = () => store.getOperatorConversation('operator', 'business');
  beforeEach(() => {
    store = new RelayStore(new ConfigService({ RELAY_DB_PATH: ':memory:' }));
    store.onModuleInit();
    expect(store.claimConversationTurn('operator', 'business', 'turn-1')).toBe(true);
  });
  afterEach(() => store.onApplicationShutdown());

  function reserve() {
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', proposed, history)).toBe(true);
  }
  function authorize() {
    reserve();
    expect(store.bindConversationPreview('operator', 'business', 'turn-1', proposed.id, 'visible')).toBe(true);
    expect(store.authorizeConversationAction('operator', 'business', 'turn-1', proposed.id, target, 1000)).toBe(true);
  }

  it('rejects unowned locks, duplicate turns and unbound approval without changing state', () => {
    reserve();
    const before = state();
    expect(store.claimConversationTurn('operator', 'business', 'turn-2')).toBe(false);
    expect(store.authorizeConversationAction('operator', 'business', 'turn-1', proposed.id, target, 1000)).toBe(false);
    expect(store.bindConversationPreview('operator', 'business', 'wrong-turn', proposed.id, 'visible')).toBe(false);
    expect(store.bindConversationPreview('operator', 'business', 'turn-1', 'wrong-action', 'visible')).toBe(false);
    expect(state()).toEqual(before);
    store.releaseConversationTurn('operator', 'business', 'turn-1');
    const released = state();
    expect(store.claimConversationTurn('operator', 'business', 'turn-1')).toBe(false);
    expect(state()).toEqual(released);
  });

  it('rejects invalid input, second outstanding action and missing native chain', () => {
    const initial = state();
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', { ...proposed, name: 'Bad\nname' }, history)).toBe(false);
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', proposed, [])).toBe(false);
    expect(state()).toEqual(initial);
    reserve();
    const before = state();
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', { ...proposed, id: 'action-2' }, history)).toBe(false);
    expect(state()).toEqual(before);
  });

  it('rejects expired, wrong input, identity, tool ID or destination without consuming pending claim', () => {
    authorize();
    const before = state();
    const input = { name: 'Pioneer', reference: 'DDJ' };
    expect(store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'wrong', input, target, 1000)).toBe(false);
    expect(store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'call-1', { ...input, name: 'Other' }, target, 1000)).toBe(false);
    expect(store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'call-1', { ...input, price: 5 } as typeof input, target, 1000)).toBe(false);
    expect(store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'call-1', input, { ...target, companyId: 8 }, 1000)).toBe(false);
    expect(store.claimConversationCreation('other', 'business', 'turn-1', proposed.id, 'call-1', input, target, 1000)).toBe(false);
    expect(store.claimConversationCreation('operator', 'other', 'turn-1', proposed.id, 'call-1', input, target, 1000)).toBe(false);
    expect(store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'call-1', input, target, 5000)).toBe(false);
    expect(state()).toEqual(before);
    expect(store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'call-1', input, target, 1000)).toBe(true);
    expect(state().action?.status).toBe('creating');
  });

  it('claims a priced action only for the exact price, VAT mode, requested tax and cost', () => {
    const price = { amount: 45, includesTax: true, tax: { id: 1, name: 'VAT 15% G', percent: 15 }, listPrice: 39.13 };
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', { ...proposed, price, cost: 30 }, history)).toBe(true);
    expect(state().action).toMatchObject({ price, cost: 30, status: 'proposed' });
    expect(store.bindConversationPreview('operator', 'business', 'turn-1', proposed.id, 'visible')).toBe(true);
    expect(store.authorizeConversationAction('operator', 'business', 'turn-1', proposed.id, target, 1000)).toBe(true);
    const before = state();
    const input = { name: 'Pioneer', reference: 'DDJ', salePrice: 45, priceIncludesTax: true, cost: 30 };
    const claim = (changed: Record<string, unknown>) => store.claimConversationCreation('operator', 'business', 'turn-1',
      proposed.id, 'call-1', { ...input, ...changed } as typeof input, target, 1000);
    for (const changed of [{ salePrice: 46 }, { priceIncludesTax: false }, { taxId: 1 }, { cost: 31 }, { cost: undefined },
      { salePrice: undefined, priceIncludesTax: undefined }, { list_price: 39.13 }]) expect(claim(changed)).toBe(false);
    expect(state()).toEqual(before);
    expect(claim({})).toBe(true);
    expect(state().action?.status).toBe('creating');
  });

  it.each([
    { price: { amount: 45, includesTax: true, tax: { id: 1, name: 'VAT 15% G', percent: 15 }, listPrice: 0 } },
    { price: { amount: 45, includesTax: true, tax: { id: 0, name: 'VAT 15% G', percent: 15 }, listPrice: 39.13 } },
    { price: { amount: 45, includesTax: true, tax: { id: 1, name: 'VAT 15% G', percent: 15 }, listPrice: 39.13, extra: 1 } },
    { cost: -1 },
  ])('refuses to reserve an invalid priced action %j', (extra) => {
    const initial = state();
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', { ...proposed, ...extra } as typeof proposed, history)).toBe(false);
    expect(state()).toEqual(initial);
  });

  it('a creating or unknown action is terminal for replay and replacement, including interruption', () => {
    authorize();
    const claim = () => store.claimConversationCreation('operator', 'business', 'turn-1', proposed.id, 'call-1', { name: 'Pioneer', reference: 'DDJ' }, target, 1000);
    expect(claim()).toBe(true);
    const before = state();
    expect(claim()).toBe(false);
    expect(store.cancelConversationAction('operator', 'business', 'turn-1', proposed.id)).toBe(false);
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', { ...proposed, id: 'action-2' }, history)).toBe(false);
    expect(state()).toEqual(before);
    expect(store.finishConversationCreation('operator', 'business', 'turn-1', proposed.id, 'unknown')).toBe(true);
    const unknown = state();
    expect(claim()).toBe(false);
    expect(store.finishConversationCreation('operator', 'business', 'turn-1', proposed.id, 'created', 81)).toBe(false);
    expect(state()).toEqual(unknown);
  });

  it('protects unresolved approval chains while bounding full SDK history', () => {
    reserve();
    const before = state();
    expect(store.saveConversationMessages('operator', 'business', 'turn-1', [{ role: 'user', content: 'x'.repeat(65000) }])).toBe(false);
    expect(store.saveConversationMessages('operator', 'business', 'turn-1', [
      { role: 'user', content: 'Not a chain' }, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approval-1', approved: true }] },
    ])).toBe(false);
    expect(state()).toEqual(before);
    const old: ModelMessage[] = Array.from({ length: 24 }, (_, index) => [
      { role: 'user' as const, content: `old ${index}` }, { role: 'assistant' as const, content: 'old answer' },
    ]).flat();
    expect(store.saveConversationMessages('operator', 'business', 'turn-1', [...old, ...history])).toBe(true);
    expect(state().messages).toHaveLength(40);
    expect(state().messages.slice(-2)).toEqual(history);
    expect(state().action).toEqual(before.action);
  });
});
