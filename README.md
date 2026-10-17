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

A human-in-the-loop relay with no AI or Odoo involved:

1. A customer writes to the business WhatsApp number (Kapso).
2. The operator's personal WhatsApp receives `Consulta #N` with the exact customer text.
3. The operator answers by **quoting (swiping) that notification**.
4. The operator's text is sent **literally** to that customer, quoting the original question.

Behavior and safeguards:

- Only `whatsapp.message.received` events signed with `KAPSO_WEBHOOK_SECRET` and addressed to `KAPSO_PHONE_NUMBER_ID` are processed. Other events are acknowledged and ignored.
- Each WhatsApp message id is processed at most once, so redeliveries and retries have no further effect. Consultations persist in SQLite (`RELAY_DB_PATH`, built-in `node:sqlite`, Node.js >= 22.13).
- Only messages from `RELAY_OPERATOR_WA_ID` can answer. A quote from anyone else becomes a new consultation.
- A customer has at most one open consultation. Until the operator replies, further messages from that customer are added to it and forwarded as `Consulta #N (continúa)`; the operator may quote any of those notifications. After the reply, the customer's next message opens a new consultation.
- With Kapso buffering enabled on the webhook (`--buffer-enabled --buffer-window-seconds 10`), a burst of messages from one customer arrives as one batch and is forwarded as a single notification.
- Each consultation accepts one reply. Unknown or missing quotes, non-text replies and repeated replies are refused, and the operator is told nothing was sent.
- If Kapso definitely rejects a send, the operator may retry. If the outcome is uncertain (network error, 5xx), the consultation is blocked and never retried automatically.
- WhatsApp only allows free-form messages within 24 hours of the recipient's last message. The operator must have written to the business number recently to receive notifications. No templates are used.
- Customers without a phone number in the payload (business-scoped user ID only) are not handled yet.

### AI Triage and Reply Suggestions

Optional AI layer for the relay, built on the Vercel AI SDK (`ai`, `@ai-sdk/deepseek`, `zod`). DeepSeek (`deepseek-flash`) is the first provider; other providers are added as one case in `src/ai/ai-model.factory.ts`. It is off unless `AI_ENABLED=true` and `DEEPSEEK_API_KEY` is set. Customer messages are sent to the AI provider when it is on.

- **Asynchronous processing:** the webhook stores each verified delivery as a SQLite job (with `tenant_id`) and answers `200` immediately. One in-process worker runs jobs in order, resumes interrupted jobs after a restart (up to three attempts), and isolates failing jobs.
- **Social closings (F1):** when a customer without an open consultation sends a short message (up to 40 characters) that the AI classifies as a pure closing ("gracias", "ok", "👍") with confidence of at least 0.8, the relay answers with a short AI-written sentence and creates no consultation. Replies with digits, currency symbols, several lines or more than 80 characters are replaced with "¡A la orden! 😊". If the reply cannot be sent, the message becomes a consultation.
- **Reply suggestions (F2):** each operator notification can include `💡 Sugerencia: …`, drafted with two read-only tools scoped server-side: the customer's previous consultations and keyword search over past answers. Recent exchanges from the same customer are also passed directly to the AI, with instructions to avoid repeated greetings in ongoing conversations (a first contact may greet). Replying exactly `ok` (any case) while quoting that notification sends the suggestion verbatim; any other text is relayed literally.
- **Fallbacks:** a disabled AI, a timeout (`AI_TIMEOUT_MS`, default 8000 per call) or an invalid AI answer keeps the plain consultation flow without a suggestion.

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
