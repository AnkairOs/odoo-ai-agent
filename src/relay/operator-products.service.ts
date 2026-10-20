import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NewProduct, OdooProductCreationService, newProductSchema, sameProductDestination } from '../odoo/odoo-product-creation.service.js';
import { InboundMessage } from './kapso-payload.js';
import { ProductPreview, RelayStore } from './relay.store.js';
import { WHATSAPP_SENDER } from './whatsapp-sender.js';
import type { WhatsAppSender } from './whatsapp-sender.js';

const HELP = 'Uso privado: /producto <nombre> (máx. 120 caracteres), con segunda línea opcional ref: <referencia> (máx. 255). Cita la vista previa con /confirmar_producto o /cancelar_producto. No se creó nada.';
const UNAVAILABLE = 'Creación de productos no disponible. Revisa la configuración explícita de Odoo y empresa. No se creó nada.';
const BLOCKED = 'Vista previa no disponible, vencida o ya utilizada. No se inició otra creación; no se reintentará. Revisa Odoo antes de proponer otro producto.';

@Injectable()
export class OperatorProductsService {
  private readonly logger = new Logger(OperatorProductsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly store: RelayStore,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsAppSender,
    private readonly creation: OdooProductCreationService,
  ) {}

  async handle(message: InboundMessage): Promise<boolean> {
    const operator = this.config.get<string>('RELAY_OPERATOR_WA_ID');
    if (!operator || message.from !== operator ||
      message.phoneNumberId !== this.config.get<string>('KAPSO_PHONE_NUMBER_ID')) return false;
    const preview = message.quotedMessageId ? this.store.findProductPreview(message.quotedMessageId) : undefined;
    const text = message.text ?? '';
    if (message.quotedMessageId && /^\/producto(?:\s|$)/u.test(text) && !preview) return false;
    if (!/^\/(?:producto|confirmar_producto|cancelar_producto)(?:\s|$)/u.test(text) && !preview) return false;
    if (!message.quotedMessageId && text.startsWith('/producto ')) {
      await this.propose(message, operator);
    } else if (text === '/confirmar_producto' || text === '/cancelar_producto') {
      await this.consume(message, operator, preview);
    } else {
      await this.notice(operator, HELP);
    }
    return true;
  }

  private async propose(message: InboundMessage, operator: string): Promise<void> {
    const product = parseProductCommand(message.text!);
    if (!product) return this.notice(operator, HELP);
    const destination = this.creation.destination();
    if (!destination) return this.notice(operator, UNAVAILABLE);
    const preview = { ...product, ...destination, operator, businessPhone: message.phoneNumberId,
      expiresAt: Date.now() + 15 * 60_000 };
    try {
      const result = await this.sender.sendText({ to: operator, body: renderPreview(preview) });
      if (result.kind === 'sent') {
        this.store.recordProductPreview({ ...preview, messageId: result.messageId }, message.id);
      }
    } catch {
      this.logger.warn('Private product preview failed; no confirmable preview recorded');
    }
  }

  private async consume(message: InboundMessage, operator: string, preview?: ProductPreview): Promise<void> {
    if (!preview) return this.notice(operator, HELP);
    const target = this.creation.destination();
    if (!target) return this.notice(operator, UNAVAILABLE);
    if (!sameProductDestination(target, preview)) return this.notice(operator, BLOCKED);
    const cancel = message.text === '/cancelar_producto';
    if (!this.store.claimProductPreview(preview.messageId, operator, message.phoneNumberId,
      target, cancel ? 'cancelled' : 'creating', Date.now())) return this.notice(operator, BLOCKED);
    if (cancel) return this.notice(operator, 'Propuesta de producto cancelada. No se creó nada.');
    // A durable creating claim is terminal for replay, including process interruption.
    const result = await this.creation.create({ name: preview.name, reference: preview.reference }, target);
    const status = result.status === 'unavailable' ? 'rejected' : result.status;
    this.store.finishProductCreation(preview.messageId, status, result.status === 'created' ? result.id : undefined);
    const body = result.status === 'created'
      ? `Producto creado en Odoo: ID ${result.id}. Revisa los valores comerciales predeterminados en Odoo.`
      : status === 'unknown'
        ? 'Resultado de creación incierto. Revisa Odoo manualmente; esta propuesta no se reintentará.'
        : 'Odoo rechazó la creación. Esta propuesta no se reintentará; revisa Odoo antes de proponer otra.';
    await this.notice(operator, body);
  }

  private async notice(operator: string, body: string): Promise<void> {
    try {
      const result = await this.sender.sendText({ to: operator, body });
      if (result.kind !== 'sent') this.logger.warn('Private product notice not confirmed sent');
    } catch { this.logger.warn('Private product notice failed'); }
  }
}

function parseProductCommand(text: string): NewProduct | undefined {
  const lines = text.split('\n');
  if (lines.length > 2) return;
  const name = lines[0].slice('/producto '.length);
  const reference = lines.length === 2 ? /^ref: (.+)$/iu.exec(lines[1])?.[1] : undefined;
  if (lines.length === 2 && reference === undefined) return;
  const parsed = newProductSchema.safeParse({ name, ...(reference === undefined ? {} : { reference }) });
  return parsed.success ? parsed.data : undefined;
}

function renderPreview(preview: NewProduct & { url: string; db: string; companyId: number }): string {
  return `Vista previa privada de producto\nNombre: ${preview.name}\nReferencia: ${preview.reference ?? '(sin referencia)'}\nTipo: bien sin seguimiento de inventario (goods_without_tracking).\nEmpresa ID: ${preview.companyId}\nDestino: ${preview.url} · base ${preview.db}\nNo se fijan precios ni cantidades. Los campos comerciales omitidos usan los valores predeterminados de Odoo (el precio estándar puede ser 1); revísalos en Odoo. Sin imágenes ni movimientos de stock.\nVence en 15 minutos. Cita este mensaje con /confirmar_producto para crear o /cancelar_producto para cancelar. «ok» y /enviar no crean productos.`;
}
