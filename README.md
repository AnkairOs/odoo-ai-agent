# Odoo AI Agent

> Multi-channel AI Copilot & Business Automation Engine for Odoo 19, built with NestJS and TypeScript.

---

## 🎯 Overview

**Odoo AI Agent** is a modular, provider-agnostic backend orchestrator designed to connect messaging channels (WhatsApp, Telegram, Web Chat) with **Odoo 19** using structured AI tool-calling.

It acts as the intelligent bridge between end-users and your ERP, ensuring secure, multi-tenant, and controlled execution of business actions.

```
WhatsApp / Channels  ──► [ Channel Adapter ]
                               │
                               ▼
                       [ NestJS Engine ]
                               │
                     ┌─────────┴─────────┐
                     ▼                   ▼
             [ AI Providers ]    [ Business Tools ]
             (OpenAI/Claude/Gemini)      │
                                         ▼
                                  [ Odoo 19 ERP ]
```

---

## 🧱 Architectural Pillars

1. **Channel Agnostic:** Inbound messages are mapped to a canonical `IncomingMessage` schema. The core engine never assumes a specific messaging platform.
2. **AI Provider Agnostic:** Unified `AIProvider` interface allowing seamless switching between OpenAI, Anthropic, Gemini, or local models.
3. **Controlled Tool Execution:** The LLM cannot execute raw queries on Odoo. All interactions go through typed, validated business tools (`get_stock`, `search_product`, `create_sale`, `create_quotation`).
4. **Tenant Isolation:** Multi-tenancy is strictly resolved at the gateway layer and never delegated to the LLM.
5. **Action Guardrails:** Read operations are executed immediately; mutating business actions require explicit human confirmation.

---

## 🛠 Tech Stack

- **Framework:** [NestJS](https://nestjs.com/) (TypeScript)
- **ERP:** [Odoo 19](https://www.odoo.com/) (JSON-2 / External RPC APIs)
- **Testing:** Vitest & Supertest
- **Containerization:** Docker

---

## 🗺 Roadmap

- [x] Initial Architecture & NestJS Scaffolding
- [ ] Core Engine & Provider Abstractions (`AIProvider`, `ChannelAdapter`)
- [ ] WhatsApp Webhook Adapter & Inbound Pipeline
- [ ] Odoo 19 Client Service & Authentication
- [ ] Business Tools (Products, Inventory, Quotations, Sales)
- [ ] Two-step Confirmation Flow for Mutating Operations
- [ ] Message Idempotency & Queue-based Processing

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 20.x
- npm / pnpm
- Odoo 19 instance (local or remote)

### Installation

```bash
# Clone the repository
git clone https://github.com/<your-username>/odoo-ai-agent.git
cd odoo-ai-agent

# Install dependencies
npm install

# Run in development mode
npm run start:dev
```

### Running Tests

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e
```

---

## 📄 License

MIT
