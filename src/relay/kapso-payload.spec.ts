import { describe, expect, it } from 'vitest';
import { parseReceivedMessages } from './kapso-payload.js';

describe('parseReceivedMessages', () => {
  const basePayload = {
    phone_number_id: '1276774632195545',
    conversation: {
      contact_name: 'Francisco Acebo',
    },
    message: {
      id: 'wamid.123',
      from: '593993742842',
      type: 'text',
      text: { body: 'Hola, buenas tardes' },
    },
  };

  it('parses standard text message', () => {
    const [msg] = parseReceivedMessages(basePayload);
    expect(msg).toBeDefined();
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Hola, buenas tardes');
    expect(msg.contactName).toBe('Francisco Acebo');
  });

  it('extracts audio transcript from message.kapso.transcript.text', () => {
    const payload = {
      ...basePayload,
      message: {
        id: 'wamid.audio1',
        from: '593993742842',
        type: 'audio',
        audio: { id: 'media_123', voice: true },
        kapso: {
          has_media: true,
          transcript: {
            text: 'Mi estimado, quiero una cuenta de TV en vivo',
          },
        },
      },
    };

    const [msg] = parseReceivedMessages(payload);
    expect(msg).toBeDefined();
    expect(msg.type).toBe('audio');
    expect(msg.text).toBe(
      '[Audio]: Mi estimado, quiero una cuenta de TV en vivo',
    );
  });

  it('extracts audio transcript from message.kapso.content as fallback', () => {
    const payload = {
      ...basePayload,
      message: {
        id: 'wamid.audio2',
        from: '593993742842',
        type: 'audio',
        audio: { id: 'media_123' },
        kapso: {
          content:
            'Audio attached (audio.ogg) [Size: 40 KB] URL: https://api.kapso.ai/media/123\n\nTranscript: Hola amigo qué precio tiene magis',
        },
      },
    };

    const [msg] = parseReceivedMessages(payload);
    expect(msg).toBeDefined();
    expect(msg.type).toBe('audio');
    expect(msg.text).toBe('[Audio]: Hola amigo qué precio tiene magis');
  });

  it('leaves text undefined when audio has no transcript', () => {
    const payload = {
      ...basePayload,
      message: {
        id: 'wamid.audio3',
        from: '593993742842',
        type: 'audio',
        audio: { id: 'media_123' },
        kapso: {
          content: 'Audio attached (audio.ogg) [Size: 40 KB] URL: ...',
        },
      },
    };

    const [msg] = parseReceivedMessages(payload);
    expect(msg).toBeDefined();
    expect(msg.type).toBe('audio');
    expect(msg.text).toBeUndefined();
  });

  it('extracts caption from image attachments', () => {
    const payload = {
      ...basePayload,
      message: {
        id: 'wamid.img1',
        from: '593993742842',
        type: 'image',
        image: { id: 'img_123', caption: 'Ya le hice la transferencia' },
      },
    };

    const [msg] = parseReceivedMessages(payload);
    expect(msg).toBeDefined();
    expect(msg.type).toBe('image');
    expect(msg.text).toBe('Ya le hice la transferencia');
  });
});
