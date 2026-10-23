# Odoo AI Agent

Multi-channel AI Copilot & Business Automation Engine for Odoo 19, built with NestJS and TypeScript.

---

## Overview

**Odoo AI Agent** is a modular, provider-agnostic backend orchestrator designed to connect messaging platforms (WhatsApp, Telegram, Web Chat) with **Odoo 19** via structured AI tool-calling.

Its target architecture is multi-tenant middleware between end-users and the ERP system, with validated business actions, granular tenant isolation, and deterministic workflows.

> **Current MVP: single business only.** Full tenant isolation is not implemented. The `tenant_id` on queued jobs does not isolate consultations, reply suggestions or historical-answer searches. Do not connect a second business to the same instance/database until tenant isolation is implemented and tested.

```text
  [ Messaging Channels ]
  (WhatsApp / Telegram / Web)
             │
             ▼
    [ Channel Adapter ]
             │ (Canonical IncomingMessage)
             ▼
  [ NestJS Core Engine ]
             │
   ┌─────────┴─────────┐
   ▼                   ▼
[ AI Providers ]    [ Business Tools ]
(OpenAI / Claude /         │ (Validation & Policies)
 Gemini)                   ▼
                    [ Odoo 19 ERP ]
                    (Multi-tenant DBs)
```

---

## Architectural Principles

- **Channel Agnostic:** Inbound messages from diverse providers (WhatsApp Cloud API, Telegram Bot API) are normalized into a unified `IncomingMessage` contract before reaching the core domain.
- **Provider-Agnostic AI Integration:** Leverages the Strategy Pattern via a decoupled `AIProvider` interface, allowing seamless switching between Anthropic (Claude), OpenAI, Google Gemini, or local models without modifying business logic.
- **Controlled Tool Execution:** The LLM does not perform direct or arbitrary database queries. Operations are strictly governed by strongly-typed Business Tools (`search_product`, `get_stock`, `create_sale`, `create_quotation`) that validate inputs before invoking Odoo services.
- **Tenant Isolation (planned):** Multi-tenant resolution must be performed at the gateway and authorization layer based on server-controlled identity, never inferred or controlled by the language model. The current MVP does not yet implement full tenant isolation.
- **Human-in-the-Loop Safeguards:** Non-destructive operations (read/query) execute automatically; mutating business transactions (order placement, quote issuance) enforce an explicit confirmation flow.

---

## Technology Stack

- **Runtime & Framework:** Node.js (>= 22.13, for built-in `node:sqlite`), NestJS 11
- **Language:** TypeScript (Strict Mode)
- **ERP Integration:** Odoo 19 (JSON-2 / External RPC APIs)
- **Testing & Quality:** Vitest, Supertest, ESLint, Oxlint
- **Infrastructure:** Docker, Nginx Reverse Proxy

---

## Implementation Roadmap

### Phase 1: Core Domain & Contracts
- [x] Initial architecture definition and NestJS project scaffolding
- [ ] Core interfaces: `AIProvider`, `ChannelAdapter`, `OdooClient`, `BusinessTool`
- [ ] Multi-tenant context resolution pipeline

### Phase 2: Odoo 19 Client & Business Tools
- [ ] Odoo 19 JSON-RPC client service with session management
- [ ] Product and catalog query tools (`search_product`, `get_product_price`)
- [ ] Inventory availability tools (`get_stock`, `check_stock_availability`)
- [ ] Commercial transaction tools (`create_quotation`, `create_sale_order`)

### Phase 3: Messaging Adapters & Safety Layer
- [ ] WhatsApp Cloud API webhook handler and payload mapper
- [ ] Action confirmation engine for mutating operations
- [ ] Message deduplication and idempotency layer

---

## Getting Started

### Prerequisites

- Node.js >= 22.13.0
- npm or pnpm
- Running Odoo 19 instance (local Docker or remote host)

### Installation

```bash
# Clone the repository
git clone git@github.com-ankairos:AnkairOs/odoo-ai-agent.git
cd odoo-ai-agent

# Install dependencies
npm install
```

### Development

```bash
# Start in watch mode
npm run start:dev

# Build for production
npm run build
```

### Security-Sensitive Configuration

- `ODOO_DIAGNOSTICS_ENABLED`: `GET /odoo/test-connection` returns `404` unless this is exactly `true`. When enabled it uses only the server-side Odoo settings; client-supplied `url`, `db` or `apiKey` query parameters are ignored.
- `KAPSO_WEBHOOK_SECRET`: Kapso webhook requests must carry `X-Webhook-Signature`, the hex HMAC-SHA256 of the exact raw request body with this secret. Missing, malformed or mismatched signatures are rejected with `401` before any handler runs. An empty secret rejects every request. Set it only in `.env`, since `.env.example` is loaded as a fallback.

### WhatsApp Operator Relay (MVP)

A human-in-the-loop relay with optional private AI drafting and read-only Odoo product lookup:

1. A customer writes to the business WhatsApp number (Kapso).
2. The operator's personal WhatsApp receives `Consulta #N` with the exact customer text and an optional suggestion.
3. The configured operator **quotes (swipes) a consultation notification or private draft** and chooses:
   - **Private instruction**, e.g. `Dile que está a $6` or `Hazlo más amable`: AI returns a proposed customer message only to the operator. Nothing is sent to the customer and the consultation stays open.
   - **`ok`** (trimmed, case-insensitive): sends the exact draft shown in the quoted message, only if it is still the current notification. The initial suggestion also counts as a visible draft. Superseded approvals and `ok` without a draft send nothing.
   - **`/enviar <texto>`**: sends the payload literally, bypassing AI, including when AI is disabled.
4. A customer send quotes their **latest** message and closes the consultation only on confirmed success.

Example: customer asks for 400 Robux → operator quotes the consultation with `Dile que está a $6` → private proposal `La recarga de 400 Robux cuesta $6.` → operator quotes it with `Hazlo más amable` → new private proposal → operator quotes that proposal with `ok` → that exact text reaches the customer once. These are illustrative AI phrases, not guaranteed wording.

**Conversational Customer Reply Dispatch (no quote required).** Alternatively, the operator can reply naturally from the unquoted chat with the copilot. When the operator says *«dile que solo disponemos de 1 perfil a $2.25»* or *«respóndele que...»*, the LLM invokes `draft_customer_reply`, associates the reply with the latest open consultation (or an explicit ID), incorporates real Odoo catalog prices, and presents a confirmation preview:
```text
Borrador para el cliente Oscar Joel (...1883) (Consulta #4):
«Por ahora solo disponemos de opciones de 1 perfil: Disney + premium 1 perfil a $3,00 y Crunchyroll 1 perfil a $2,25.»

¿Lo envío al cliente? Responde «sí» o «ok» para enviarlo. Vence en 15 minutos.
```
Responding «sí» or «ok» immediately dispatches the reply to the customer's WhatsApp, quoting their original message, and marks the consultation `replied`. Responding «no» cancels without sending.


`/enviar` must be the first exact command token (optional leading whitespace). The command and **one whitespace separator** are removed; all remaining spaces, punctuation and newlines are preserved. `/enviar` with no non-whitespace payload gives private usage guidance. `/enviarme` and embedded `/enviar` are ordinary drafting instructions. Every customer-send route requires a valid quote; there is no unquoted customer-send mode.

Behavior and safeguards:

- Only `whatsapp.message.received` events signed with `KAPSO_WEBHOOK_SECRET` and addressed to `KAPSO_PHONE_NUMBER_ID` are processed. Other events are acknowledged and ignored.
- Each WhatsApp message id is processed at most once, so redeliveries and retries have no further effect. Consultations persist in SQLite (`RELAY_DB_PATH`, built-in `node:sqlite`, Node.js >= 22.13).
- Only messages from `RELAY_OPERATOR_WA_ID` can answer. A quote from anyone else becomes a new consultation.
- A customer has at most one open consultation. Until the operator replies, further messages from that customer are added to it and forwarded as `Consulta #N (continúa)`; the operator may quote older notifications for revision or `/enviar`, but cannot approve a superseded draft. After the reply, the customer's next message opens a new consultation.
- With Kapso buffering enabled on the webhook (`--buffer-enabled --buffer-window-seconds 10`), a burst of messages from one customer arrives as one batch and is forwarded as a single notification.
- Each consultation accepts one reply. Unknown or missing quotes, non-text replies and repeated replies are refused, and the operator is told nothing was sent.
- If Kapso definitely rejects a send, the operator may retry. If the outcome is uncertain (network error, 5xx), the consultation is blocked and never retried automatically.
- WhatsApp only allows free-form messages within 24 hours of the recipient's last message. The operator must have written to the business number recently to receive notifications. No templates are used.
- Customers without a phone number in the payload (business-scoped user ID only) are not handled yet.

### AI Triage and Reply Suggestions

Optional AI layer for the relay, built on the Vercel AI SDK (`ai`, `@ai-sdk/deepseek`, `zod`). DeepSeek (`deepseek-flash`) is the first provider; other providers are added as one case in `src/ai/ai-model.factory.ts`. It is off unless `AI_ENABLED=true` and `DEEPSEEK_API_KEY` is set. Customer messages are sent to the AI provider when it is on.

- **Asynchronous processing:** the webhook stores each verified delivery as a SQLite job (with `tenant_id`) and answers `200` immediately. One in-process worker runs jobs in order, resumes interrupted jobs after a restart (up to three attempts), and isolates failing jobs.
- **Social closings (F1):** when a customer without an open consultation sends a short message (up to 40 characters) that the AI classifies as a pure closing ("gracias", "ok", "👍") with confidence of at least 0.8, the relay answers with a short AI-written sentence and creates no consultation. Replies with digits, currency symbols, several lines or more than 80 characters are replaced with "¡A la orden! 😊". If the reply cannot be sent, the message becomes a consultation.
- **Reply suggestions (F2):** each operator notification can include `💡 Sugerencia: …`, drafted with three read-only tools scoped server-side: the customer's previous consultations, keyword search over past answers, and Odoo product name/reference lookup. Recent exchanges from the same customer are also passed directly to the AI, with instructions to avoid repeated greetings in ongoing conversations (a first contact may greet). Replying exactly `ok` (trimmed, any case) while quoting the current notification sends the suggestion verbatim. Ordinary operator text instead requests a private draft or revision using the full current consultation, the exact quoted draft and the operator instruction. Successful private proposals are persisted in the existing notification mapping, so they can be revised or approved after a restart; they are not recorded as customer replies. When the product lookup finds matches, the prompt asks the draft to name them (at most five) and ask the customer which one they mean, without stating price or stock.
- **Facts and privacy:** prompts forbid inventing stock, delivery times, discounts or promises from a price instruction. This is prompt guidance, not a factual guarantee: the operator must review the draft. Private instructions and unsent drafts are not customer history or searchable past answers; when enabled, AI receives the instruction and draft as context. Confirmed sent answers remain retrievable, not model training or permanent approved business knowledge. No unbounded operator chat history is kept.
- **Fallbacks:** a disabled AI, a timeout (`AI_TIMEOUT_MS`, default 8000 per call), an error or an invalid/empty draft gives an operator-only notice and never forwards the instruction literally. The consultation remains open; use `/enviar <texto>` to send without AI. Consultations already replied to or with an uncertain customer send refuse all further sends.

### Read-only Odoo Product Lookup (single business)

Set **all three** server settings explicitly: `ODOO_DEFAULT_URL` (your Odoo 19 URL), `ODOO_DEFAULT_DB` (the exact database), and `ODOO_DEFAULT_API_KEY` (the dedicated Odoo account's API key). Keep the key secret, outside source control. Unlike the diagnostic client's defaults, product lookup does not fall back to localhost or a default database when settings are missing or blank; it returns `unavailable` without contacting Odoo. AI drafting must also be enabled as described above.

Both initial suggestions and private operator revisions can use `search_odoo_products` with only a `query` (1–120 characters after trimming). The server fixes the URL, database, credential, model (`product.product`), method (`search_read`), active/saleable filters and limit (5). It searches name or internal reference and returns only `id`, `name`, `default_code`: **no price, stock, order creation or arbitrary ORM access**. An empty successful result means no matches; a failed, malformed or unconfigured lookup returns only `unavailable` to the AI, not raw error details. Product text is untrusted data, never instructions. Lookup failure leaves human drafting and `/enviar` available.

The call uses the configured Odoo user's existing ACLs and record rules, without sudo or bypass. Configure that account's product-read permissions and allowed companies in Odoo itself. This remains one fixed business connection, **not full tenant isolation**; AI cannot select another destination or company. Product names/references retrieved by a tool are sent to the AI provider when enabled. The operator must still check every draft and quote the current one with `ok` before sending it.

Manual example (not executed): a customer asks `¿Tienen Cable CB1?`; the initial draft may search for `Cable CB1`. The operator can quote the notification and write `Busca el producto por referencia CB1 y prepara una respuesta sin precio ni stock`. Review the private proposal, then quote it with `ok` only if correct. No live product lookup, AI or WhatsApp validation has been performed for this change; automated checks use mocks only.

### Operator-only Product Creation (single business)

This **write capability is off by default**. The legacy commands below remain deterministic and work with AI disabled. The separate private conversation described next can propose the same operation through an approval-required AI tool. Only the exact configured operator on the configured business phone can propose or confirm products. Neither route sends a customer message.

Enable only with explicit server settings (do not put credentials in chat):

- `ODOO_PRODUCT_CREATION_ENABLED=true` (exact string).
- `ODOO_PRODUCT_COMPANY_ID`: a positive integer company ID you have verified in Odoo. For the agreed test setup, verify **My Company / company 1 / database test** before configuring; **1 is not a fallback**.
- All of `ODOO_DEFAULT_URL`, `ODOO_DEFAULT_DB`, `ODOO_DEFAULT_API_KEY` must be explicit and nonblank. Use a dedicated account with appropriate product-create permissions and company access. Diagnostic defaults are never used.

Send the business number this operator command **unquoted** (not replying to another message):

```text
/producto Pioneer DDJ
ref: DDJ-1
```

The name is trimmed, nonempty, at most 120 characters; the optional `ref:` second line is trimmed, nonempty and at most 255 characters (`REF:` also works). Names retain internal spaces. Only plain catalog text (letters, numbers, spaces and common catalog punctuation) is accepted, not URLs, extra lines or arbitrary fields. Omit the second line entirely for no reference. Images, prices, stock quantities and movements are not supported.

Initiation via `/producto` is unquoted only. Quoting a consultation with `/producto ...` remains a private consultation-revision instruction; quoting a product preview cannot initiate another proposal.

Review the private preview, including company ID and fixed URL/database. **Quote that preview** with exactly `/confirmar_producto` to create, or `/cancelar_producto` to cancel, within 15 minutes. An unquoted command cannot create. `ok` and `/enviar` retain consultation semantics and **never confirm a product**. Each successfully recorded preview authorizes at most one create attempt; a new explicit `/producto` proposal is allowed, including the same name/reference. Neither is a uniqueness or idempotency key.

The only mutation is JSON-2 `product.product/create` with one `vals_list` entry containing `name`, optional `default_code`, `type: 'consu'` (Odoo 19 Goods), `is_storable: false`, and the configured `company_id`. **Omitted commercial fields use Odoo defaults: standard Odoo can assign a price of 1. Review prices and other defaults directly in Odoo before use. The `/producto` commands never set prices or quantities** (only the private conversation below can add a price, cost and sales tax). The selected type is goods without inventory tracking, not service. See official Odoo 19 [product defaults](https://github.com/odoo/odoo/blob/19.0/addons/product/models/product_template.py), [stock defaults](https://github.com/odoo/odoo/blob/19.0/addons/stock/models/product.py) and [JSON-2 controller](https://github.com/odoo/odoo/blob/19.0/addons/rpc/controllers/json2.py).

A separate additive SQLite table stores immutable preview values and operator/business/destination bindings, never the API key or customer history. Current URL/database/company must still match before confirmation. The attempt is claimed durably **before** HTTP. Cancelled, expired, already claimed or mismatched previews cannot create. Interrupted `creating` claims remain blocked after restart. Only one positive ID in Odoo's response counts as created; network failures, a 10-second timeout, ambiguous HTTP failures or malformed success are uncertain and never retried. Definite authentication/endpoint rejection also consumes the preview. Success stays recorded even if its private notice fails. **For an uncertain or interrupted attempt, inspect Odoo manually before proposing another product**: this is not exactly-once remote execution or catalog deduplication.

No live Odoo creation, AI or WhatsApp delivery has been exercised; automated tests use mocks and isolated SQLite state only.

### Private Operator Conversation (single business)

With AI enabled, the configured operator can write ordinary **unquoted** text to the configured business number:

```text
Hola, ¿qué puedes hacer?
Busca Pioneer
Quiero crear Pioneer 2, referencia DDJ
[Review the private preview]
Sí
```

The Vercel SDK chooses whether to answer, ask for missing information or call tools, with at most four generation steps per turn. Capability instructions come from the actual server registry: `search_products` exists only with explicit lookup settings; `create_product`, `update_product`, `archive_product` and the read-only `list_sales_taxes` exist only when the mutation opt-in and fixed destination are valid. These are the only Odoo operations in this conversation. A name is required and a reference is optional. There is no keyword-intent router or new agent engine.

Replies are written for WhatsApp: 1–3 plain-text sentences, greeting only when the operator greets or on the first message, no repeated capability lists, no tool names or technical codes, and no offers to change stock, images or permanently delete products. Before sending, model text is normalized deterministically: `**bold**` becomes `*bold*`, heading markers are stripped and Markdown tables become `• ` lines (header and separator dropped, cells joined with ` – `). Deterministic notices are sent verbatim. The private preview looks like:

```text
Voy a crear este producto en Odoo (catalog):
• Nombre: Pioneer 2
• Referencia: DDJ
• Sin control de inventario
El precio quedará con el valor por defecto de Odoo (puede ser 1); revísalo después.
¿Lo creo? Responde «sí» o dime qué cambiar. Vence en 15 minutos.
```

**Price, cost and VAT (optional).** The operator can add a sale price and a cost (positive amounts up to 1,000,000 with at most 2 decimals; cost may be 0) and say in the moment whether the price includes VAT (`con IVA incluido`) or not (`sin IVA`, `más IVA`, `IVA fuera del precio`). If a price is given without saying, the AI asks once «¿Ese precio incluye IVA?» before proposing. `list_sales_taxes` returns only active percent sale taxes of the configured company (`id`, `name`, `percent`; fixed model, domain and limit 50; taxes marked price-included are excluded). The AI picks a tax from that list (for example `IVA 0%` → `VAT 0% G`); without a stated tax it sends none and the server uses the company default sale tax (`account_sale_tax_id`). The model never computes money: the server validates the tax against the current active list (an unknown/inactive tax or a failed lookup gives a notice and no proposal), computes the untaxed `list_price` (`round(price / (1 + rate/100), 2)` when VAT is included, otherwise the price as given) and stores price, VAT mode, tax ID/name/percent, base and cost in the immutable action. Example:

```text
Voy a crear este producto en Odoo (catalog):
• Nombre: Pioneer 2
• Referencia: DDJ
• Sin control de inventario
• Precio: $39.13 + IVA 15% = $45.00
• Costo: $30.00
¿Lo creo? Responde «sí» o dime qué cambiar. Vence en 15 minutos.
```

The total is computed from the stored base. Without a price the default-price warning stays; without a cost there is no cost line. The write adds `list_price`, `standard_price` and `taxes_id: [[6, 0, [taxId]]]` (the resolved tax, also when it is the company default) only when present. Any price, VAT or cost change needs a new preview and approval. Before the write the server re-reads the active sale taxes; if the stored tax is gone or its name/rate/base differs, the action is consumed as rejected without HTTP. Assumes a company configured with tax-excluded prices and a `$` currency; the dedicated account's permission to write cost has not been verified live.

**Updating and archiving products (S1–S5).** When mutation is enabled, the operator can update fields (name, reference, sale price with VAT, cost) or archive existing products by ID. The system reads current values from Odoo before proposing. Updating generates a comparative before-and-after preview for modified fields:

```text
Voy a actualizar «Pioneer 2» (ID 81) en Odoo (catalog):
• Nombre: Pioneer 2 ➔ Pioneer 3
• Precio: $26.09 (+ IVA 15% = $30.00) ➔ $34.78 (+ IVA 15% = $40.00)
¿Lo actualizo? Responde «sí» o dime qué cambiar. Vence en 15 minutos.
```

Archiving performs a soft delete via Odoo JSON-2 `product.product/write` setting `active: false`, with a preview warning that the product will be hidden from sales and searches. Hard delete (`unlink`) is disallowed. Both operations require human confirmation, 15-minute expiry, durable pre-HTTP claims and replay safety.

**Batch operations and conversational chaining (S1–S5).** When mutation is enabled, the operator can perform multi-item operations with a single consolidated preview and one-touch natural confirmation ("sí", "dale", "hazlo", "de una"):

- **Batch creation (`create_products`):** Dictate or paste 2 to 20 products with or without prices, VAT mode or cost. A single preview lists each product with its commercial parameters (`• Nombre – ref: X – precio + IVA – costo`). On approval, Odoo creates all products natively in a single `vals_list` write:
  ```text
  Voy a crear estos 2 productos en Odoo (catalog):
  • Pioneer 2 – ref: DDJ – $39.13 + IVA 15% = $45.00 – costo: $30.00
  • Sony Alpha – sin ref – $86.96 + IVA 15% = $100.00
  ¿Los creo? Responde «sí» para crearlos o dime qué cambiar. Vence en 15 minutos.
  ```
  Confirmation notice: `¡Listo! Creé los 2 productos en Odoo. ¿Deseas hacer algo más con ellos o buscar en el catálogo?`

- **Batch update (`update_products`):** Modify fields (name, reference, sale price with VAT, cost) for 2 to 20 existing products in a single turn. Current values are fetched from Odoo to render a comparative before ➔ after preview for each modified field:
  ```text
  Voy a actualizar estos 2 productos en Odoo (catalog):
  • ID 81 (Pioneer 2): precio: $26.09 (+ IVA 15% = $30.00) ➔ $34.78 (+ IVA 15% = $40.00)
  • ID 82 (Sony Alpha): costo: $50.00 ➔ $60.00
  ¿Los actualizo? Responde «sí» o dime qué cambiar. Vence en 15 minutos.
  ```
  On approval, updates are grouped by values to minimize RPC calls. If all succeed: `¡Listo! Actualicé los 2 productos en Odoo. ¿Deseas consultar cómo quedaron o realizar otra modificación?` If any write fails, a partial outcome report details how many succeeded and lists unadjusted IDs: `Actualicé 1 de 2 productos en Odoo. Los productos con ID [82] no se modificaron. Revísalos en Odoo.`

- **Batch archive (`archive_products`):** Archive 2 to 50 existing products by ID (e.g. «Archiva todos los pioneer» or «Archiva los productos 81 y 82»). Previews all targeted products with ID and name, warning they will be hidden from the sales catalog:
  ```text
  Voy a archivar estos 2 productos en Odoo (catalog):
  • ID 81: Pioneer 2 (ref: DDJ)
  • ID 82: Sony Alpha
  • Los productos quedarán archivados y ocultos del catálogo de ventas.
  ¿Los archivo? Responde «sí» para confirmar o «no» para cancelar. Vence en 15 minutos.
  ```
  On approval, soft-deletes via `active: false` and confirms: `¡Listo! Archivé los 2 productos en Odoo. Quedaron ocultos del catálogo de ventas. ¿Deseas hacer algo más?`

- **Conversational chaining and friendly guidance (S4):** Upon completing an action, the agent proactively offers next steps (reviewing changes, editing another, archiving or catalog search). When multiple proposals or parallel requests arise, the assistant guides the operator toward batch support rather than rigidly refusing: `Puedo crear, editar o archivar varios productos a la vez con una sola confirmación. Dime los productos y los preparo en lote.` Natural rejections ("no", "cancela") cancel batch proposals cleanly (`Listo, no los creé.`, `Listo, no los actualicé.`, `Listo, no los archivé.`), and 15-minute expiration discards stale proposals automatically.

**Catalog search with prices, overview and pagination (S7).** `search_products` accepts an optional `query` and optional `offset` (integer between 0 and 10,000, default 0, limit 5). When `query` is omitted, empty or whitespace, it returns active saleable products ordered by ID descending (newest first). When provided, it filters by name or reference ordered by name ascending. The tool calls `search_read` with `['id', 'name', 'default_code', 'list_price', 'taxes_id']` and `search_count` for total matching products, returning `{ status: 'ok', products, total, offset }`. This allows the conversational agent to present the general catalog overview with real prices, answer price questions, and paginate through products upon request.

**Production Controls and Operator Configuration (S1–S4).** Designed for real-world production deployments:

- **Dynamic Operator Phone Resolution (`OdooOperatorService`):** The system dynamically resolves the active operator's WhatsApp number by querying the configured company in Odoo (`POST /json/2/res.company/read` with field `phone`). Phone numbers are normalized (e.g. Ecuadorian mobile `0992849536` or `+593 99...` becomes `593992849536`). Results are cached in memory for 5 minutes (TTL) to avoid redundant ERP queries. If Odoo is unreachable, times out (5s), or the phone field is empty, the system falls back seamlessly to `RELAY_OPERATOR_WA_ID` from the environment.
- **Customer Inquiries Switch & Total Silence (`set_customer_inquiries`):** The operator can pause or resume customer inquiry processing using natural WhatsApp conversation (e.g. «Pausa las consultas de clientes», «Deja de recibir consultas», «Activa las consultas de nuevo»). The state is persisted in SQLite (`app_settings` table, default `true`). When paused:
  - Inbound customer messages are consumed with **total silence**: zero AI calls, zero suggestions, zero WhatsApp replies, and zero operator notifications.
  - Human staff can freely chat with customers directly from WhatsApp Business without bot interference.
  - Operator copilot commands (product creation, updates, catalog search) continue working normally.
  - The operator can inspect the switch status at any time with `get_customer_inquiries_status` (e.g. «¿Están activas las consultas?»).


Creation uses native SDK `user-approval`. An approval-only SDK response is a valid proposal, not a failed empty answer. Before any send, SQLite records one immutable action with the exact name/reference, goods-without-tracking type, fixed URL/database/company, call/approval IDs and 15-minute expiry. Only a confirmed private preview delivery enables approval. The deterministic preview warns about Odoo's default commercial values, including the possible default price of 1. Unknown or rejected delivery cannot authorize a write; model prose cannot change the preview's fields.

A separate tool-free structured call classifies only the **fresh human reply to that visible proposal** as approve, reject, clarify or change. Ambiguous replies ask again without effects. A change rejects the old native call and requires a new visible preview and another confirmation. A single “yes” never approves parallel proposals. Assistant text, tool results and greetings are not consent. Unquoted slash commands and exact trimmed, case-insensitive `ok` never enter this flow. Quoted consultation revisions, `/enviar`, stale-draft checks and all legacy product commands retain their existing meanings. Customers never receive a write tool.

Full native SDK messages, including tool calls/results and approval requests/responses, are stored separately from customer history, scoped to operator/business and bounded to 40 messages and 64 KB. Pruning removes whole turns and refuses to discard an unresolved approval chain. The installed SDK requires a contiguous call/result group and a final tool approval-response message: the fresh human answer is inserted just before the pending assistant call group, with the matching server-added approval response last. Only then is the native SDK resumed; its `tool.execute` performs the write, not an out-of-band executor. Full history uses SDK `responseMessages`, not the last-step-only `response.messages`.

A SQLite turn claim serializes each operator/business conversation, with durable inbound-event deduplication. Concurrent/busy replies are conservatively ignored rather than queued as consent. A process interrupted while holding a turn leaves it blocked after restart; there is no automatic lease recovery. The creation tool rechecks current identity, exact input/call/destination, expiry and a non-reversible authority-configuration fingerprint, then atomically claims `creating` **before** the existing creation service makes its single HTTP attempt. No credentials are stored in the conversation. An expired **unexecuted** proposal (`proposed` or `pending`, including an unconfirmed preview) is discarded on the next eligible conversational turn: its native call is explicitly denied and settled, and a deterministic private notice confirms the discard. That turn's text is not reused as a fresh creation request; the next fresh turn can greet, search or request a new product. Creating still requires a new visible preview and another fresh approval. Configuration drift and unexpired unconfirmed previews still block approval. Expiry never recovers `approved`, `creating`, `unknown` or interrupted/busy execution state, never retargets a proposal and never retries a write. Those blocked execution states still require controlled operational recovery after inspecting Odoo; there is no chat reset or automatic retry.

A created ID and a safe tool result are persisted before further model generation or notice delivery. Narration failure or an uncertain success notice cannot turn a recorded success into a failure or retry. Replaying an approved SDK history still encounters the consumed durable claim. This is local at-most-once attempt protection, not remote exactly-once execution or product uniqueness. Provider retries do not retry external mutation.

Automated validation uses `MockLanguageModelV4`, mocked HTTP/senders and isolated SQLite state. No live AI, WhatsApp delivery, Odoo permissions, commercial defaults or database writes have been validated.

### Testing

```bash
# Run unit tests
npm run test

# Run end-to-end tests
npm run test:e2e
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
