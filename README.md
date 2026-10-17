# Odoo AI Agent

Multi-channel AI Copilot & Business Automation Engine for Odoo 19, built with NestJS and TypeScript.

---

## Overview

**Odoo AI Agent** is a modular, provider-agnostic backend orchestrator designed to connect messaging platforms (WhatsApp, Telegram, Web Chat) with **Odoo 19** via structured AI tool-calling.

It acts as a secure, multi-tenant middleware between end-users and the ERP system, ensuring validated business action execution, granular tenant isolation, and deterministic workflows.

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
- **Tenant Isolation:** Multi-tenant resolution is strictly performed at the gateway and authorization layer based on user identity, never inferred or controlled by the language model.
- **Human-in-the-Loop Safeguards:** Non-destructive operations (read/query) execute automatically; mutating business transactions (order placement, quote issuance) enforce an explicit confirmation flow.

---

## Technology Stack

- **Runtime & Framework:** Node.js (>= 20.x), NestJS 11
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

- Node.js >= 20.0.0
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
