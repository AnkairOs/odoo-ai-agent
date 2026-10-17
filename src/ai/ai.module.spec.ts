import { describe, it, expect } from 'vitest';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AiModule } from './ai.module.js';
import { AiService } from './ai.service.js';

describe('AiModule', () => {
  async function resolveService(env: Record<string, string>) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        AiModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(env))
      .compile();
    return moduleRef.get(AiService);
  }

  it('wires AiService with the DeepSeek factory when enabled', async () => {
    const service = await resolveService({
      AI_ENABLED: 'true',
      DEEPSEEK_API_KEY: 'sk-test',
    });

    expect(service.isEnabled()).toBe(true);
  });

  it('wires a disabled AiService when the kill switch is off', async () => {
    const service = await resolveService({ DEEPSEEK_API_KEY: 'sk-test' });

    expect(service.isEnabled()).toBe(false);
  });
});
