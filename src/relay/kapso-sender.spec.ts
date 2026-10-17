import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { KapsoSender } from './whatsapp-sender.js';

const CONFIG = {
  KAPSO_API_KEY: 'test-api-key',
  KAPSO_PHONE_NUMBER_ID: '100000000000001',
};

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('KapsoSender', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a Meta-shaped text message through the Kapso proxy', async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ messages: [{ id: 'wamid.SENT' }] }),
    );
    const sender = new KapsoSender(new ConfigService(CONFIG));

    const result = await sender.sendText({
      to: '15550001111',
      body: ' hola\n',
      contextMessageId: 'wamid.Q',
    });

    expect(result).toEqual({ kind: 'sent', messageId: 'wamid.SENT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://api.kapso.ai/meta/whatsapp/v23.0/100000000000001/messages',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-API-Key': 'test-api-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550001111',
      type: 'text',
      text: { body: ' hola\n', preview_url: false },
      context: { message_id: 'wamid.Q' },
    });
  });

  it('honours configured base url and graph version', async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ messages: [{ id: 'wamid.SENT' }] }),
    );
    const sender = new KapsoSender(
      new ConfigService({
        ...CONFIG,
        KAPSO_API_BASE_URL: 'https://proxy.test/meta/',
        KAPSO_GRAPH_VERSION: 'v24.0',
      }),
    );

    await sender.sendText({ to: '15550001111', body: 'hola' });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://proxy.test/meta/v24.0/100000000000001/messages');
  });

  it('reports a 4xx response as a definite rejection', async () => {
    stubFetch(async () => new Response('bad', { status: 400 }));

    const result = await new KapsoSender(new ConfigService(CONFIG)).sendText({
      to: '1',
      body: 'x',
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'HTTP 400' });
  });

  it.each([
    [
      'a 5xx response',
      async () => new Response('down', { status: 503 }),
      'HTTP 503',
    ],
    [
      'a network error',
      async () => Promise.reject(new TypeError('fetch failed')),
      'fetch failed',
    ],
    [
      'a success without message id',
      async () => Response.json({ messages: [] }),
      'respuesta sin id de mensaje',
    ],
  ])('reports %s as an unknown outcome', async (_label, impl, reason) => {
    stubFetch(impl);

    const result = await new KapsoSender(new ConfigService(CONFIG)).sendText({
      to: '1',
      body: 'x',
    });

    expect(result).toEqual({ kind: 'unknown', reason });
  });

  it('rejects without calling Kapso when it is not configured', async () => {
    const fetchMock = stubFetch(async () => Response.json({}));

    const result = await new KapsoSender(new ConfigService({})).sendText({
      to: '1',
      body: 'x',
    });

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'Kapso no está configurado',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
