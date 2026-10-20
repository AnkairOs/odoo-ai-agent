import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { AiService } from './ai.service.js';
import {
  createAiModel,
  type AiModelFactory,
  type AiModelSettings,
} from './ai-model.factory.js';
import { defineAiTool } from './ai.types.js';

type LanguageModelV4GenerateResult = Awaited<
  ReturnType<MockLanguageModelV4['doGenerate']>
>;

const ENABLED_ENV = { AI_ENABLED: 'true', DEEPSEEK_API_KEY: 'sk-test' };

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(10, 5),
    warnings: [],
  };
}

function toolCallResult(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = `call-${toolName}`,
): LanguageModelV4GenerateResult {
  return {
    content: [
      { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: usage(20, 3),
    warnings: [],
  };
}

function createService(
  env: Record<string, string>,
  model: MockLanguageModelV4 = new MockLanguageModelV4(),
) {
  const settingsSeen: AiModelSettings[] = [];
  const factory: AiModelFactory = (settings) => {
    settingsSeen.push(settings);
    return { model };
  };
  const service = new AiService(new ConfigService(env), factory);
  return { service, model, settingsSeen };
}

const triageSchema = z.object({
  kind: z.enum(['social_closing', 'consultation']),
  reply: z.string(),
});

const userMessages = [{ role: 'user' as const, content: 'gracias' }];

describe('AiService native conversations', () => {
  it('returns full SDK tool-cycle messages and reuses them on a follow-up', async () => {
    const execute = vi.fn(async () => ({ products: [{ name: 'Pioneer', reference: 'DDJ' }] }));
    const model = new MockLanguageModelV4({ doGenerate: [
      toolCallResult('search_products', { query: 'Pioneer' }), textResult('Encontré Pioneer.'), textResult('DDJ'),
    ] });
    const { service } = createService(ENABLED_ENV, model);
    const tools = { search_products: defineAiTool({ inputSchema: z.object({ query: z.string() }), execute }) };
    const first = await service.generateConversation({ system: 's', messages: userMessages, tools, approvalRequiredTools: [] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(execute).toHaveBeenCalledTimes(1);
    const next = await service.generateConversation({ system: 's', messages: [...userMessages, ...first.messages,
      { role: 'user', content: '¿Referencia?' }], tools, approvalRequiredTools: [] });
    expect(next).toMatchObject({ ok: true, text: 'DDJ' });
    expect(JSON.stringify(model.doGenerateCalls[2].prompt)).toContain('DDJ');
  });

  it('approval-only output is valid and only a native approval response executes the stored call', async () => {
    const execute = vi.fn(async () => ({ status: 'created', id: 81 }));
    const model = new MockLanguageModelV4({ doGenerate: [
      toolCallResult('create_product', { name: 'Pioneer' }), textResult('Creado'),
    ] });
    const { service } = createService(ENABLED_ENV, model);
    const tools = { create_product: defineAiTool({ inputSchema: z.object({ name: z.string() }).strict(), execute }) };
    const first = await service.generateConversation({ system: 's', messages: userMessages, tools,
      approvalRequiredTools: ['create_product'] });
    expect(first).toMatchObject({ ok: true, text: '', approvals: [{ toolName: 'create_product', input: { name: 'Pioneer' } }] });
    expect(execute).not.toHaveBeenCalled();
    if (!first.ok) return;
    const next = await service.generateConversation({ system: 's', tools, approvalRequiredTools: ['create_product'],
      messages: [...userMessages, { role: 'user', content: 'sí, créalo' }, ...first.messages,
        { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: first.approvals[0].approvalId, approved: true }] }],
    });
    expect(next).toMatchObject({ ok: true, text: 'Creado' });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'Pioneer' }, expect.objectContaining({ toolCallId: 'call-create_product' }));
    if (next.ok) expect(next.messages.map((message) => message.role)).toEqual(['tool', 'assistant']);
  });

  it('never executes denied native calls', async () => {
    const execute = vi.fn(async () => 'not allowed');
    const model = new MockLanguageModelV4({ doGenerate: [toolCallResult('create_product', { name: 'Pioneer' }), textResult('Cancelado')] });
    const { service } = createService(ENABLED_ENV, model);
    const tools = { create_product: defineAiTool({ inputSchema: z.object({ name: z.string() }), execute }) };
    const first = await service.generateConversation({ system: 's', messages: userMessages, tools, approvalRequiredTools: ['create_product'] });
    if (!first.ok) throw new Error('expected approval request');
    const next = await service.generateConversation({ system: 's', tools, approvalRequiredTools: ['create_product'],
      messages: [...userMessages, { role: 'user', content: 'no' }, ...first.messages,
        { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: first.approvals[0].approvalId, approved: false }] }],
    });
    expect(next).toMatchObject({ ok: true, text: 'Cancelado' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('AiService configuration', () => {
  it('is disabled unless AI_ENABLED is exactly "true"', () => {
    for (const value of ['', 'TRUE', '1', 'yes', 'false']) {
      const { service } = createService({ ...ENABLED_ENV, AI_ENABLED: value });
      expect(service.isEnabled()).toBe(false);
    }
    const { service: noFlag } = createService({ DEEPSEEK_API_KEY: 'sk' });
    expect(noFlag.isEnabled()).toBe(false);
  });

  it('is disabled when the provider API key is missing', () => {
    const { service, settingsSeen } = createService({ AI_ENABLED: 'true' });

    expect(service.isEnabled()).toBe(false);
    expect(settingsSeen).toHaveLength(0);
  });

  it('is disabled for an unknown provider', () => {
    const { service, settingsSeen } = createService({
      ...ENABLED_ENV,
      AI_PROVIDER: 'openai-typo',
    });

    expect(service.isEnabled()).toBe(false);
    expect(settingsSeen).toHaveLength(0);
  });

  it('uses deepseek, deepseek-flash and no base URL override by default', () => {
    const { service, settingsSeen } = createService(ENABLED_ENV);

    expect(service.isEnabled()).toBe(true);
    expect(settingsSeen).toEqual([
      {
        provider: 'deepseek',
        apiKey: 'sk-test',
        baseUrl: undefined,
        model: 'deepseek-flash',
      },
    ]);
  });

  it('honours AI_PROVIDER, AI_MODEL and DEEPSEEK_BASE_URL overrides', () => {
    const { settingsSeen } = createService({
      ...ENABLED_ENV,
      AI_PROVIDER: 'deepseek',
      AI_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/beta',
    });

    expect(settingsSeen[0]).toEqual({
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/beta',
      model: 'deepseek-v4-pro',
    });
  });

  it('is disabled when the model factory throws', () => {
    const factory: AiModelFactory = () => {
      throw new Error('boom');
    };
    const service = new AiService(new ConfigService(ENABLED_ENV), factory);

    expect(service.isEnabled()).toBe(false);
  });

  it('returns disabled from both operations without calling the model', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('{}') });
    const { service } = createService({}, model);

    const structured = await service.generateStructured({
      system: 's',
      messages: userMessages,
      schema: triageSchema,
    });
    const tools = await service.generateWithTools({
      system: 's',
      messages: userMessages,
      tools: {},
    });

    expect(structured).toMatchObject({ ok: false, reason: 'disabled' });
    expect(tools).toMatchObject({ ok: false, reason: 'disabled' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe('AiService.generateStructured', () => {
  it('returns the schema-validated object and token usage', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: textResult(
        JSON.stringify({ kind: 'social_closing', reply: '¡A la orden!' }),
      ),
    });
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateStructured({
      system: 'Clasifica el mensaje',
      messages: userMessages,
      schema: triageSchema,
    });

    expect(result).toEqual({
      ok: true,
      object: { kind: 'social_closing', reply: '¡A la orden!' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const call = model.doGenerateCalls[0];
    expect(call.responseFormat).toMatchObject({ type: 'json' });
    expect(call.prompt[0]).toEqual({
      role: 'system',
      content: 'Clasifica el mensaje',
    });
    expect(call.prompt[1]).toMatchObject({ role: 'user' });
  });

  it('passes the provider structured-call options from the factory', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: textResult(
        JSON.stringify({ kind: 'consultation', reply: '' }),
      ),
    });
    const factory: AiModelFactory = () => ({
      model,
      structuredProviderOptions: {
        deepseek: { thinking: { type: 'disabled' } },
      },
    });
    const service = new AiService(new ConfigService(ENABLED_ENV), factory);

    await service.generateStructured({
      system: 's',
      messages: userMessages,
      schema: triageSchema,
    });

    expect(model.doGenerateCalls[0].providerOptions).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
  });

  it('returns invalid_output when the response does not match the schema', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: textResult(JSON.stringify({ kind: 'other' })),
    });
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateStructured({
      system: 's',
      messages: userMessages,
      schema: triageSchema,
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_output' });
  });

  it('returns invalid_output when the response is not JSON', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: textResult('no soy json'),
    });
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateStructured({
      system: 's',
      messages: userMessages,
      schema: triageSchema,
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_output' });
  });

  it('returns provider_error when the provider call fails', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error('401 Unauthorized')),
    });
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateStructured({
      system: 's',
      messages: userMessages,
      schema: triageSchema,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'provider_error',
      detail: expect.stringContaining('401 Unauthorized'),
    });
  });

  it('returns timeout when the provider does not answer within AI_TIMEOUT_MS', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener('abort', () =>
            reject(abortSignal.reason),
          );
        }),
    });
    const { service } = createService(
      { ...ENABLED_ENV, AI_TIMEOUT_MS: '20' },
      model,
    );

    const result = await service.generateStructured({
      system: 's',
      messages: userMessages,
      schema: triageSchema,
    });

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('AiService.generateWithTools', () => {
  const lookupInput = z.object({ product: z.string() });

  it('executes a tool, feeds its result back and returns the final answer', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('lookupPrice', { product: 'recarga 10' }),
        textResult('Sí, hay recarga de $10'),
      ],
    });
    const execute = vi.fn(async ({ product }: { product: string }) => ({
      product,
      available: true,
    }));
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateWithTools({
      system: 'Sugiere una respuesta',
      messages: userMessages,
      tools: {
        lookupPrice: defineAiTool({
          description: 'Busca precio',
          inputSchema: lookupInput,
          execute,
        }),
      },
    });

    expect(result).toEqual({
      ok: true,
      text: 'Sí, hay recarga de $10',
      toolsExecuted: ['lookupPrice'],
      usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
    });
    expect(execute).toHaveBeenCalledWith(
      { product: 'recarga 10' },
      expect.anything(),
    );
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
      '"available":true',
    );
  });

  it('reports a failing tool back to the model instead of failing the call', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('lookupPrice', { product: 'x' }),
        textResult('No pude consultar el precio'),
      ],
    });
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateWithTools({
      system: 's',
      messages: userMessages,
      tools: {
        lookupPrice: defineAiTool({
          description: 'Busca precio',
          inputSchema: lookupInput,
          execute: async (): Promise<unknown> => {
            throw new Error('db offline');
          },
        }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'No pude consultar el precio',
      toolsExecuted: ['lookupPrice'],
    });
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
      'db offline',
    );
  });

  it('stops after maxSteps and reports invalid_output when no answer was produced', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve(toolCallResult('lookupPrice', { product: 'x' })),
    });
    const execute = vi.fn(async () => ({ available: false }));
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateWithTools({
      system: 's',
      messages: userMessages,
      maxSteps: 2,
      tools: {
        lookupPrice: defineAiTool({
          description: 'Busca precio',
          inputSchema: lookupInput,
          execute,
        }),
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_output' });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('bounds the loop at 4 steps by default', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve(toolCallResult('lookupPrice', { product: 'x' })),
    });
    const { service } = createService(ENABLED_ENV, model);

    await service.generateWithTools({
      system: 's',
      messages: userMessages,
      tools: {
        lookupPrice: defineAiTool({
          description: 'Busca precio',
          inputSchema: lookupInput,
          execute: async () => ({}),
        }),
      },
    });

    expect(model.doGenerateCalls).toHaveLength(4);
  });

  it('returns provider_error when the provider call fails', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error('503')),
    });
    const { service } = createService(ENABLED_ENV, model);

    const result = await service.generateWithTools({
      system: 's',
      messages: userMessages,
      tools: {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'provider_error' });
  });

  it('returns timeout when a tool hangs past the timeout', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('slow', { product: 'x' }),
        textResult('never'),
      ],
    });
    const { service } = createService(
      { ...ENABLED_ENV, AI_TIMEOUT_MS: '20' },
      model,
    );

    const result = await service.generateWithTools({
      system: 's',
      messages: userMessages,
      tools: {
        slow: defineAiTool({
          description: 'lento',
          inputSchema: lookupInput,
          execute: (_input, { abortSignal }) =>
            new Promise((_, reject) => {
              abortSignal?.addEventListener('abort', () =>
                reject(abortSignal.reason),
              );
            }),
        }),
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('createAiModel', () => {
  it('builds a DeepSeek chat model with thinking disabled for structured calls', () => {
    const { model, structuredProviderOptions } = createAiModel({
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: undefined,
      model: 'deepseek-flash',
    });

    expect(typeof model).toBe('object');
    expect(model).toMatchObject({
      modelId: 'deepseek-flash',
      provider: expect.stringContaining('deepseek'),
    });
    expect(structuredProviderOptions).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
  });
});
