import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayStore, type ConversationAction, type ConversationActionProposal } from './relay.store.js';

const target = { url: 'https://odoo.test', db: 'catalog', companyId: 7 };
const proposed: Omit<ConversationAction, 'status'> = { ...target, id: 'action-1', name: 'Pioneer', reference: 'DDJ',
  toolCallId: 'call-1', approvalId: 'approval-1', authorityFingerprint: 'test-fingerprint', expiresAt: 5000 };
const history: ModelMessage[] = [{ role: 'user', content: 'Crea Pioneer' }, { role: 'assistant', content: [
  { type: 'tool-call', toolName: 'create_product', toolCallId: 'call-1', input: { name: 'Pioneer', reference: 'DDJ' } },
  { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' },
] }];

describe.each(['create_batch', 'update_batch', 'archive_batch'] as const)('durable %s', (kind) => {
  let store: RelayStore;
  const items = kind === 'create_batch' ? [{ name: 'First' }, { name: 'Second' }] : kind === 'update_batch'
    ? [{ productId: 11, currentValues: { name: 'First' }, proposedValues: { reference: 'A' } },
      { productId: 12, currentValues: { name: 'Second' }, proposedValues: { reference: 'B' } }]
    : [{ productId: 11, name: 'First' }, { productId: 12, name: 'Second' }];
  const input = { items: kind === 'create_batch' ? [{ name: 'First' }, { name: 'Second' }] : kind === 'update_batch'
    ? [{ productId: 11, reference: 'A' }, { productId: 12, reference: 'B' }] : [{ productId: 11 }, { productId: 12 }] };
  const proposal = { ...target, id: 'batch', kind, items, approvalId: 'approval', toolCallId: 'call',
    authorityFingerprint: 'fingerprint', expiresAt: 5000 } as ConversationActionProposal;
  const toolName = kind === 'create_batch' ? 'create_products' : kind === 'update_batch' ? 'update_products' : 'archive_products';
  const messages = (payload: unknown = input): ModelMessage[] => [{ role: 'assistant', content: [
    { type: 'tool-call', toolName, toolCallId: 'call', input: payload },
    { type: 'tool-approval-request', approvalId: 'approval', toolCallId: 'call' },
  ] }];
  const reserve = (action = proposal, history = messages()) => store.reserveConversationAction('op', 'phone', 'turn', action, history);
  const claim = (payload: unknown = input, destination = target, timestamp = 1000, call = 'call') =>
    store.claimConversationBatch('op', 'phone', 'turn', 'batch', call, payload, destination, timestamp);
  const state = () => store.getOperatorConversation('op', 'phone');
  beforeEach(() => {
    store = new RelayStore(new ConfigService({ RELAY_DB_PATH: ':memory:' }));
    store.onModuleInit();
    expect(store.claimConversationTurn('op', 'phone', 'turn')).toBe(true);
  });
  afterEach(() => store.onApplicationShutdown());
  function approve() {
    expect(reserve()).toBe(true);
    expect(claim()).toBe(false);
    expect(store.authorizeConversationAction('op', 'phone', 'turn', 'batch', target, 1000)).toBe(false);
    expect(store.bindConversationPreview('op', 'phone', 'turn', 'batch', 'visible')).toBe(true);
    expect(store.authorizeConversationAction('op', 'phone', 'turn', 'batch', target, 1000)).toBe(true);
  }
  it('binds ordered native tool payload and rejects bounds, duplicates and altered second items', () => {
    expect(reserve(proposal, messages({ items: [...input.items].reverse() }))).toBe(false);
    expect(reserve({ ...proposal, items: items.slice(0, 1) } as ConversationActionProposal)).toBe(false);
    expect(reserve({ ...proposal, items: Array.from({ length: kind === 'archive_batch' ? 51 : 21 }, () => items[0]) } as ConversationActionProposal)).toBe(false);
    if (kind !== 'create_batch') expect(reserve({ ...proposal, items: [items[0], items[0]] } as ConversationActionProposal)).toBe(false);
    approve();
    const before = state();
    for (const payload of [{ items: [...input.items].reverse() }, { items: input.items.slice(0, 1) },
      { items: [input.items[0], { ...input.items[1], unexpected: true }] }, { ...input, extra: true }]) expect(claim(payload)).toBe(false);
    expect(claim(input, { ...target, companyId: 8 })).toBe(false);
    expect(claim(input, target, 5000)).toBe(false);
    expect(claim(input, target, 1000, 'wrong')).toBe(false);
    expect(state()).toEqual(before);
    expect(claim()).toBe(true);
    expect(claim()).toBe(false);
    expect(store.finishConversationBatch('op', 'phone', 'turn', 'batch', 'created', { completedProductIds: [11], uncertainProductIds: [] })).toBe(false);
    expect(store.finishConversationBatch('op', 'phone', 'turn', 'batch', 'created', { completedProductIds: [11, 12], uncertainProductIds: [] })).toBe(true);
    expect(state().action).toMatchObject({ items, status: 'created', outcome: { completedProductIds: [11, 12], uncertainProductIds: [] } });
    expect(claim()).toBe(false);
  });
  it('persists immutable items and unknown partial outcomes, blocking replacement and retries', () => {
    approve();
    const snapshot = state();
    const returned = state().action;
    if (returned && 'items' in returned) (returned.items as unknown[]).reverse();
    expect(state()).toEqual(snapshot);
    expect(store.saveConversationMessages('op', 'phone', 'turn', messages({ items: [...input.items].reverse() }))).toBe(false);
    expect(claim()).toBe(true);
    const outcome = { completedProductIds: [11], uncertainProductIds: [12] };
    expect(store.finishConversationBatch('op', 'phone', 'turn', 'batch', 'unknown', outcome)).toBe(true);
    outcome.completedProductIds.push(99);
    expect(state().action).toMatchObject({ status: 'unknown', outcome: { completedProductIds: [11], uncertainProductIds: [12] } });
    expect(reserve()).toBe(false);
    expect(claim()).toBe(false);
    expect(store.finishConversationBatch('op', 'phone', 'turn', 'batch', 'created', { completedProductIds: [11, 12], uncertainProductIds: [] })).toBe(false);
  });
});

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

  it('reserves, authorizes, claims, and completes an update action', () => {
    const updateProposed: ConversationActionProposal = {
      kind: 'update',
      ...target,
      id: 'update-1',
      productId: 42,
      currentValues: { name: 'Pioneer', reference: 'DDJ', listPrice: 20, cost: 10, taxId: 1 },
      proposedValues: {
        name: 'Pioneer 2',
        reference: 'DDJ-2',
        price: { amount: 30, includesTax: true, tax: { id: 1, name: 'VAT 15%', percent: 15 }, listPrice: 26.09 },
        cost: 15,
      },
      toolCallId: 'update-call-1',
      approvalId: 'update-app-1',
      authorityFingerprint: 'test-fingerprint',
      expiresAt: 5000,
    };
    const updateHistory: ModelMessage[] = [
      { role: 'user', content: 'Actualiza Pioneer' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'update_product', toolCallId: 'update-call-1', input: { productId: 42, name: 'Pioneer 2' } },
          { type: 'tool-approval-request', approvalId: 'update-app-1', toolCallId: 'update-call-1' },
        ],
      },
    ];

    expect(store.reserveConversationAction('operator', 'business', 'turn-1', updateProposed, updateHistory)).toBe(true);
    expect(state().action).toMatchObject({ kind: 'update', productId: 42, status: 'proposed' });
    expect(store.bindConversationPreview('operator', 'business', 'turn-1', updateProposed.id, 'visible-update')).toBe(true);
    expect(store.authorizeConversationAction('operator', 'business', 'turn-1', updateProposed.id, target, 1000)).toBe(true);

    const matchingInput = {
      productId: 42,
      name: 'Pioneer 2',
      reference: 'DDJ-2',
      salePrice: 30,
      priceIncludesTax: true,
      cost: 15,
    };
    expect(store.claimConversationUpdate('operator', 'business', 'turn-1', updateProposed.id, 'wrong-call', matchingInput, target, 1000)).toBe(false);
    expect(store.claimConversationUpdate('operator', 'business', 'turn-1', updateProposed.id, 'update-call-1', { ...matchingInput, productId: 99 }, target, 1000)).toBe(false);
    expect(store.claimConversationUpdate('operator', 'business', 'turn-1', updateProposed.id, 'update-call-1', { ...matchingInput, name: 'Mismatch' }, target, 1000)).toBe(false);
    expect(store.claimConversationUpdate('operator', 'business', 'turn-1', updateProposed.id, 'update-call-1', matchingInput, target, 6000)).toBe(false);

    expect(store.claimConversationUpdate('operator', 'business', 'turn-1', updateProposed.id, 'update-call-1', matchingInput, target, 1000)).toBe(true);
    expect(state().action?.status).toBe('creating');
    expect(store.finishConversationAction('operator', 'business', 'turn-1', updateProposed.id, 'created')).toBe(true);
    expect(state().action?.status).toBe('created');
  });

  it('reserves, authorizes, claims, and completes an archive action', () => {
    const archiveProposed: ConversationActionProposal = {
      kind: 'archive',
      ...target,
      id: 'archive-1',
      productId: 88,
      name: 'Old Pioneer',
      reference: 'OLD-1',
      toolCallId: 'archive-call-1',
      approvalId: 'archive-app-1',
      authorityFingerprint: 'test-fingerprint',
      expiresAt: 5000,
    };
    const archiveHistory: ModelMessage[] = [
      { role: 'user', content: 'Archiva Old Pioneer' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'archive_product', toolCallId: 'archive-call-1', input: { productId: 88 } },
          { type: 'tool-approval-request', approvalId: 'archive-app-1', toolCallId: 'archive-call-1' },
        ],
      },
    ];

    expect(store.reserveConversationAction('operator', 'business', 'turn-1', archiveProposed, archiveHistory)).toBe(true);
    expect(state().action).toMatchObject({ kind: 'archive', productId: 88, status: 'proposed' });
    expect(store.bindConversationPreview('operator', 'business', 'turn-1', archiveProposed.id, 'visible-archive')).toBe(true);
    expect(store.authorizeConversationAction('operator', 'business', 'turn-1', archiveProposed.id, target, 1000)).toBe(true);

    expect(store.claimConversationArchive('operator', 'business', 'turn-1', archiveProposed.id, 'wrong-call', { productId: 88 }, target, 1000)).toBe(false);
    expect(store.claimConversationArchive('operator', 'business', 'turn-1', archiveProposed.id, 'archive-call-1', { productId: 99 }, target, 1000)).toBe(false);
    expect(store.claimConversationArchive('operator', 'business', 'turn-1', archiveProposed.id, 'archive-call-1', { productId: 88 }, target, 6000)).toBe(false);

    expect(store.claimConversationArchive('operator', 'business', 'turn-1', archiveProposed.id, 'archive-call-1', { productId: 88 }, target, 1000)).toBe(true);
    expect(state().action?.status).toBe('creating');
    expect(store.finishConversationAction('operator', 'business', 'turn-1', archiveProposed.id, 'created')).toBe(true);
    expect(state().action?.status).toBe('created');
  });

  it('rejects invalid update/archive reservations and cross-kind claims', () => {
    const invalidUpdate: ConversationActionProposal = {
      kind: 'update',
      ...target,
      id: 'update-inv',
      productId: 0,
      currentValues: { name: 'Pioneer' },
      proposedValues: { cost: -5 },
      toolCallId: 'update-call-inv',
      approvalId: 'update-app-inv',
      authorityFingerprint: 'test-fingerprint',
      expiresAt: 5000,
    };
    const updateHistory: ModelMessage[] = [
      { role: 'user', content: 'Actualiza' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'update_product', toolCallId: 'update-call-inv', input: { productId: 0 } },
          { type: 'tool-approval-request', approvalId: 'update-app-inv', toolCallId: 'update-call-inv' },
        ],
      },
    ];

    expect(store.reserveConversationAction('operator', 'business', 'turn-1', invalidUpdate, updateHistory)).toBe(false);

    const validArchive: ConversationActionProposal = {
      kind: 'archive',
      ...target,
      id: 'archive-val',
      productId: 77,
      name: 'Pioneer',
      toolCallId: 'archive-call-val',
      approvalId: 'archive-app-val',
      authorityFingerprint: 'test-fingerprint',
      expiresAt: 5000,
    };
    const archiveHistory: ModelMessage[] = [
      { role: 'user', content: 'Archiva' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'archive_product', toolCallId: 'archive-call-val', input: { productId: 77 } },
          { type: 'tool-approval-request', approvalId: 'archive-app-val', toolCallId: 'archive-call-val' },
        ],
      },
    ];

    expect(store.reserveConversationAction('operator', 'business', 'turn-1', validArchive, archiveHistory)).toBe(true);
    expect(store.bindConversationPreview('operator', 'business', 'turn-1', validArchive.id, 'preview-msg')).toBe(true);

    // Cancel action works while pending
    expect(store.cancelConversationAction('operator', 'business', 'turn-1', validArchive.id)).toBe(true);
    expect(state().action?.status).toBe('cancelled');
  });

  it('reserves, binds, claims, and completes a reply_customer action', () => {
    const replyProposed: ConversationActionProposal = {
      kind: 'reply_customer',
      ...target,
      id: 'reply-1',
      consultationId: 4,
      customerWaId: 'customer-wa-1',
      customerName: 'Juan',
      replyText: 'Solo por perfil a 2.25',
      lastCustomerMessageId: 'wamid.customer-1',
      toolCallId: 'reply-call-1',
      approvalId: 'reply-app-1',
      authorityFingerprint: 'test-fingerprint',
      expiresAt: 5000,
    };
    const replyHistory: ModelMessage[] = [
      { role: 'user', content: 'Dile que solo por perfil a 2.25' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: 'draft_customer_reply',
            toolCallId: 'reply-call-1',
            input: { consultationId: 4, replyText: 'Solo por perfil a 2.25' },
          },
          { type: 'tool-approval-request', approvalId: 'reply-app-1', toolCallId: 'reply-call-1' },
        ],
      },
    ];

    expect(store.reserveConversationAction('operator', 'business', 'turn-1', replyProposed, replyHistory)).toBe(true);
    expect(state().action).toMatchObject({
      kind: 'reply_customer',
      consultationId: 4,
      customerWaId: 'customer-wa-1',
      customerName: 'Juan',
      replyText: 'Solo por perfil a 2.25',
      lastCustomerMessageId: 'wamid.customer-1',
      status: 'proposed',
    });

    expect(store.bindConversationPreview('operator', 'business', 'turn-1', replyProposed.id, 'visible-reply')).toBe(true);
    expect(state().action?.status).toBe('pending');

    // Reject claim if expired
    expect(store.claimConversationAction('operator', 'business', 'turn-1', replyProposed.id, 6000)).toBe(false);

    // Claim succeeds when pending and unexpired
    expect(store.claimConversationAction('operator', 'business', 'turn-1', replyProposed.id, 1000)).toBe(true);
    expect(state().action?.status).toBe('creating');

    // Finish action
    expect(store.finishConversationAction('operator', 'business', 'turn-1', replyProposed.id, 'created')).toBe(true);
    expect(state().action?.status).toBe('created');
  });

  it('rejects invalid reply_customer proposal parameters', () => {
    const invalidReply: ConversationActionProposal = {
      kind: 'reply_customer',
      ...target,
      id: 'reply-inv',
      consultationId: 0,
      customerWaId: '',
      replyText: '',
      lastCustomerMessageId: '',
      toolCallId: 'reply-call-inv',
      approvalId: 'reply-app-inv',
      authorityFingerprint: 'test-fingerprint',
      expiresAt: 5000,
    };
    const history: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: 'draft_customer_reply',
            toolCallId: 'reply-call-inv',
            input: { replyText: '' },
          },
          { type: 'tool-approval-request', approvalId: 'reply-app-inv', toolCallId: 'reply-call-inv' },
        ],
      },
    ];
    expect(store.reserveConversationAction('operator', 'business', 'turn-1', invalidReply, history)).toBe(false);
  });
});

describe('open consultation queries and status transitions', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(new ConfigService({ RELAY_DB_PATH: ':memory:' }));
    store.onModuleInit();
  });

  afterEach(() => {
    store.onApplicationShutdown();
  });

  it('returns undefined when no consultations exist', () => {
    expect(store.getLatestOpenConsultation()).toBeUndefined();
  });

  it('returns undefined for consultations not awaiting reply', () => {
    const id = store.createConsultation({
      customerWaId: 'cust-1',
      customerMessageId: 'm-1',
      lastCustomerMessageId: 'm-1',
      question: '¿Tienen stock?',
    });
    // In status 'notifying'
    expect(store.getStatus(id)).toBe('notifying');
    expect(store.getLatestOpenConsultation()).toBeUndefined();

    // In status 'notify_failed'
    store.recordNotificationFailed(id, 'notify_failed', 'err');
    expect(store.getLatestOpenConsultation()).toBeUndefined();
  });

  it('returns the latest consultation in awaiting_reply with full details', () => {
    const id1 = store.createConsultation({
      customerWaId: 'cust-1',
      customerName: 'Carlos',
      customerMessageId: 'm-1',
      lastCustomerMessageId: 'm-1',
      question: '¿Precio de Pioneer?',
    });
    store.recordNotificationSent(id1, 'notif-1');

    const id2 = store.createConsultation({
      customerWaId: 'cust-2',
      customerName: 'Maria',
      customerMessageId: 'm-2',
      lastCustomerMessageId: 'm-2-last',
      question: '¿Tienen audífonos?',
    });
    store.recordNotificationSent(id2, 'notif-2');

    const latest = store.getLatestOpenConsultation();
    expect(latest).toBeDefined();
    expect(latest).toEqual({
      id: id2,
      customerWaId: 'cust-2',
      customerName: 'Maria',
      lastCustomerMessageId: 'm-2-last',
      question: '¿Tienen audífonos?',
      status: 'awaiting_reply',
    });

    // Lookup by ID
    const first = store.getLatestOpenConsultation(id1);
    expect(first).toEqual({
      id: id1,
      customerWaId: 'cust-1',
      customerName: 'Carlos',
      lastCustomerMessageId: 'm-1',
      question: '¿Precio de Pioneer?',
      status: 'awaiting_reply',
    });
  });

  it('updates status and text with setReplied', () => {
    const id = store.createConsultation({
      customerWaId: 'cust-1',
      customerMessageId: 'm-1',
      lastCustomerMessageId: 'm-1',
      question: '¿Tienen stock?',
    });
    store.recordNotificationSent(id, 'notif-1');
    expect(store.getLatestOpenConsultation()?.id).toBe(id);

    store.setReplied(id, 'Sí, tenemos disponible.');
    expect(store.getStatus(id)).toBe('replied');
    expect(store.getLatestOpenConsultation()).toBeUndefined();
  });
});

describe('customer inquiries switch persistence', () => {
  it('defaults to true, toggles to false and true', () => {
    const store = new RelayStore(new ConfigService({ RELAY_DB_PATH: ':memory:' }));
    store.onModuleInit();
    try {
      expect(store.isCustomerInquiriesEnabled()).toBe(true);

      store.setCustomerInquiriesEnabled(false);
      expect(store.isCustomerInquiriesEnabled()).toBe(false);

      store.setCustomerInquiriesEnabled(true);
      expect(store.isCustomerInquiriesEnabled()).toBe(true);
    } finally {
      store.onApplicationShutdown();
    }
  });

  it('persists inquiries enabled switch across store re-instantiations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-inquiries-'));
    const dbPath = join(dir, 'relay.sqlite');
    try {
      const config = new ConfigService({ RELAY_DB_PATH: dbPath });

      let store = new RelayStore(config);
      store.onModuleInit();
      expect(store.isCustomerInquiriesEnabled()).toBe(true);

      store.setCustomerInquiriesEnabled(false);
      expect(store.isCustomerInquiriesEnabled()).toBe(false);
      store.onApplicationShutdown();

      store = new RelayStore(config);
      store.onModuleInit();
      expect(store.isCustomerInquiriesEnabled()).toBe(false);

      store.setCustomerInquiriesEnabled(true);
      expect(store.isCustomerInquiriesEnabled()).toBe(true);
      store.onApplicationShutdown();

      store = new RelayStore(config);
      store.onModuleInit();
      expect(store.isCustomerInquiriesEnabled()).toBe(true);
      store.onApplicationShutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

