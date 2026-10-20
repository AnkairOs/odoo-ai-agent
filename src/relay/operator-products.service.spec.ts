import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OdooProductCreationService } from '../odoo/odoo-product-creation.service.js';
import { InboundMessage } from './kapso-payload.js';
import { OperatorProductsService } from './operator-products.service.js';
import { RelayStore } from './relay.store.js';
import { WhatsAppSender } from './whatsapp-sender.js';

const HELP = 'Uso privado: /producto <nombre> (máx. 120 caracteres), con segunda línea opcional ref: <referencia> (máx. 255). Cita la vista previa con /confirmar_producto o /cancelar_producto. No se creó nada.';
const UNAVAILABLE = 'Creación de productos no disponible. Revisa la configuración explícita de Odoo y empresa. No se creó nada.';
const BLOCKED = 'Vista previa no disponible, vencida o ya utilizada. No se inició otra creación; no se reintentará. Revisa Odoo antes de proponer otro producto.';
const PREVIEW = 'Vista previa privada de producto\nNombre: Pioneer  DDJ\nReferencia: DDJ-1\nTipo: bien sin seguimiento de inventario (goods_without_tracking).\nEmpresa ID: 1\nDestino: https://odoo.invalid · base test\nNo se fijan precios ni cantidades. Los campos comerciales omitidos usan los valores predeterminados de Odoo (el precio estándar puede ser 1); revísalos en Odoo. Sin imágenes ni movimientos de stock.\nVence en 15 minutos. Cita este mensaje con /confirmar_producto para crear o /cancelar_producto para cancelar. «ok» y /enviar no crean productos.';

describe('private operator products', () => {
  let values: Record<string, unknown>;
  let config: ConfigService;
  let store: RelayStore;
  let service: OperatorProductsService;
  let creation: OdooProductCreationService;
  let send: ReturnType<typeof vi.fn<WhatsAppSender['sendText']>>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let dir: string;
  let sequence: number;

  function start() {
    config = new ConfigService(values);
    store = new RelayStore(config);
    store.onModuleInit();
    creation = new OdooProductCreationService(config);
    service = new OperatorProductsService(config, store, { sendText: send }, creation);
  }

  async function say(text: string, quote?: string, overrides: Partial<InboundMessage> = {}) {
    return service.handle({ id: `in-${++sequence}`, from: 'operator', phoneNumberId: 'business', type: 'text', text, quotedMessageId: quote, ...overrides });
  }

  async function propose() {
    await say('/producto Pioneer  DDJ\nref: DDJ-1');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: PREVIEW });
    expect(store.findProductPreview('preview')?.status).toBe('pending');
  }

  beforeEach(() => {
    sequence = 0;
    dir = mkdtempSync(join(tmpdir(), 'operator-products-'));
    values = { RELAY_DB_PATH: join(dir, 'relay.sqlite'), RELAY_OPERATOR_WA_ID: 'operator', KAPSO_PHONE_NUMBER_ID: 'business',
      ODOO_PRODUCT_CREATION_ENABLED: 'true', ODOO_PRODUCT_COMPANY_ID: '1', ODOO_DEFAULT_URL: 'https://odoo.invalid', ODOO_DEFAULT_DB: 'test', ODOO_DEFAULT_API_KEY: 'fake-key' };
    send = vi.fn<WhatsAppSender['sendText']>().mockResolvedValue({ kind: 'sent', messageId: 'preview' });
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('[42]'));
    vi.stubGlobal('fetch', fetchMock);
    start();
  });

  afterEach(() => {
    store.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it('previews immutable values privately, then creates once across confirmations and restart', async () => {
    await propose();
    expect(fetchMock).not.toHaveBeenCalled();
    await say('/confirmar_producto', 'preview');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: 'Producto creado en Odoo: ID 42. Revisa los valores comerciales predeterminados en Odoo.' });
    expect(store.findProductPreview('preview')).toMatchObject({ status: 'created', productId: 42, name: 'Pioneer  DDJ', reference: 'DDJ-1' });
    await say('/confirmar_producto', 'preview');
    store.onApplicationShutdown(); start();
    await say('/confirmar_producto', 'preview');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: BLOCKED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.customerHistory('operator', 0)).toEqual([]);
    expect(store.searchPastAnswers(['Pioneer'])).toEqual([]);
    expect(store.findOpenForCustomer('operator')).toBeUndefined();
  });

  it.each(['ok', '/enviar literal', '/confirmar_producto extra', '/cancelar_producto extra', '/confirmar_producto\nref: other'])('does not confirm via %s', async (command) => {
    await propose(); await say(command, 'preview');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: HELP });
    expect(store.findProductPreview('preview')?.status).toBe('pending');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/productos', '/productor', 'dile /producto Pioneer', '/confirmar_producto_extra'])('leaves non-command tokens in the existing operator flow: %s', async (text) => {
    expect(await say(text)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.findProductPreview('preview')).toBeUndefined();
  });

  it.each(['/producto Quoted product', '/producto', '/producto\tQuoted product'])('lets quoted initiation tokens fall through without a product preview: %s', async (text) => {
    expect(await say(text, 'consultation-notification')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.findProductPreview('preview')).toBeUndefined();
  });

  it('does not initiate another product from a quoted product preview', async () => {
    await propose();
    const original = store.findProductPreview('preview');
    send.mockResolvedValue({ kind: 'sent', messageId: 'nested-notice' });
    expect(await say('/producto Quoted product', 'preview')).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: HELP });
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.findProductPreview('preview')).toEqual(original);
    expect(store.findProductPreview('nested-notice')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not replace immutable preview values when recording the same message twice', async () => {
    await propose();
    const preview = store.findProductPreview('preview')!;
    expect(store.recordProductPreview({ ...preview, name: 'Changed', companyId: 2 }, 'different-event')).toBe(false);
    expect(store.findProductPreview('preview')).toMatchObject({ name: 'Pioneer  DDJ', companyId: 1, status: 'pending' });
  });

  it.each(['/confirmar_producto', '/cancelar_producto'])('requires a bound quote for %s', async (command) => {
    await propose();
    await say(command); await say(command, 'unknown');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: HELP });
    expect(store.findProductPreview('preview')?.status).toBe('pending');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/producto', '/producto   ', '/producto X\nref:', '/producto X\nprice: 5', '/producto X\nref: a\nref: b', '/producto X\n', '/producto https://bad.invalid', '/producto X price: 5', `/producto ${'a'.repeat(121)}`, `/producto X\nref: ${'r'.repeat(256)}`])('rejects invalid input without proposals: %s', async (command) => {
    await say(command);
    expect(send).toHaveBeenCalledExactlyOnceWith({ to: 'operator', body: HELP });
    expect(store.findProductPreview('preview')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.customerHistory('operator', 0)).toEqual([]);
  });

  it('accepts trimmed bounded names and case-insensitive optional references', async () => {
    await say(`/producto ${'a'.repeat(120)}  \nREF: ${'r'.repeat(255)} `);
    expect(store.findProductPreview('preview')).toMatchObject({ name: 'a'.repeat(120), reference: 'r'.repeat(255) });
  });

  it('accepts a name alone without inventing a reference', async () => {
    await say('/producto Pioneer');
    expect(store.findProductPreview('preview')).toMatchObject({ name: 'Pioneer', reference: undefined });
    await say('/confirmar_producto', 'preview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ from: 'customer' }, { phoneNumberId: 'other' }])('does not handle unauthorized messages %j', async (override) => {
    expect(await say('/producto Pioneer', undefined, override)).toBe(false);
    expect(await say('/confirmar_producto', 'preview', override)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.findProductPreview('preview')).toBeUndefined();
  });

  it.each(['ODOO_PRODUCT_CREATION_ENABLED', 'ODOO_PRODUCT_COMPANY_ID', 'ODOO_DEFAULT_URL', 'ODOO_DEFAULT_DB', 'ODOO_DEFAULT_API_KEY'])('disables proposals without %s', async (key) => {
    values[key] = '';
    await say('/producto Pioneer');
    expect(send).toHaveBeenCalledExactlyOnceWith({ to: 'operator', body: UNAVAILABLE });
    expect(store.findProductPreview('preview')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['ODOO_DEFAULT_URL', 'ODOO_DEFAULT_DB', 'ODOO_PRODUCT_COMPANY_ID', 'RELAY_OPERATOR_WA_ID', 'KAPSO_PHONE_NUMBER_ID'])('cannot retarget an existing preview after %s changes', async (key) => {
    await propose();
    values[key] = key === 'ODOO_PRODUCT_COMPANY_ID' ? '2' : key === 'ODOO_DEFAULT_URL' ? 'https://changed.invalid' : 'changed';
    await say('/confirmar_producto', 'preview', { from: String(values.RELAY_OPERATOR_WA_ID), phoneNumberId: String(values.KAPSO_PHONE_NUMBER_ID) });
    expect(send).toHaveBeenLastCalledWith({ to: String(values.RELAY_OPERATOR_WA_ID), body: BLOCKED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('expires proposals and cancels only once', async () => {
    vi.useFakeTimers();
    await propose();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await say('/confirmar_producto', 'preview');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: BLOCKED });
    send.mockResolvedValue({ kind: 'sent', messageId: 'second' });
    await say('/producto Another');
    await say('/cancelar_producto', 'second');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: 'Propuesta de producto cancelada. No se creó nada.' });
    await say('/confirmar_producto', 'second');
    expect(store.findProductPreview('second')?.status).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'rejected'] as const)('never reuses an attempted %s mutation', async (status) => {
    await propose();
    fetchMock.mockResolvedValue(new Response('', { status: status === 'unknown' ? 500 : 403 }));
    await say('/confirmar_producto', 'preview');
    expect(store.findProductPreview('preview')?.status).toBe(status);
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: status === 'unknown'
      ? 'Resultado de creación incierto. Revisa Odoo manualmente; esta propuesta no se reintentará.'
      : 'Odoo rechazó la creación. Esta propuesta no se reintentará; revisa Odoo antes de proponer otra.' });
    await say('/confirmar_producto', 'preview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists a claim before HTTP and blocks concurrent confirmations and interrupted claims after restart', async () => {
    await propose();
    let release!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = say('/confirmar_producto', 'preview');
    expect(store.findProductPreview('preview')?.status).toBe('creating');
    await say('/confirmar_producto', 'preview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(new Response('[42]')); await first;
    send.mockResolvedValue({ kind: 'sent', messageId: 'interrupted' });
    await say('/producto Interrupted');
    expect(store.claimProductPreview('interrupted', 'operator', 'business', creation.destination()!, 'creating', Date.now())).toBe(true);
    store.onApplicationShutdown(); start();
    await say('/confirmar_producto', 'interrupted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.findProductPreview('interrupted')?.status).toBe('creating');
  });

  it.each(['unknown', 'rejected', 'throws'] as const)('does not record failed preview sends: %s', async (kind) => {
    if (kind === 'throws') send.mockRejectedValueOnce(new Error('sender'));
    else send.mockResolvedValueOnce({ kind, reason: 'failed' });
    await say('/producto Pioneer');
    await say('/confirmar_producto', 'preview');
    expect(store.findProductPreview('preview')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['ODOO_PRODUCT_CREATION_ENABLED', 'ODOO_PRODUCT_COMPANY_ID', 'ODOO_DEFAULT_API_KEY'])('refuses confirmation if %s is removed after preview', async (key) => {
    await propose();
    values[key] = '';
    await say('/confirmar_producto', 'preview');
    expect(send).toHaveBeenLastCalledWith({ to: 'operator', body: UNAVAILABLE });
    expect(store.findProductPreview('preview')?.status).toBe('pending');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'rejected', 'throws'] as const)('keeps success terminal even when success notice fails: %s', async (kind) => {
    await propose();
    if (kind === 'throws') send.mockRejectedValueOnce(new Error('sender'));
    else send.mockResolvedValueOnce({ kind, reason: 'failed' });
    await say('/confirmar_producto', 'preview');
    expect(store.findProductPreview('preview')?.status).toBe('created');
    await say('/confirmar_producto', 'preview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
