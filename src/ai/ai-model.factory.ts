import { createDeepSeek } from '@ai-sdk/deepseek';
import type { generateText, LanguageModel } from 'ai';

export type ProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]['providerOptions']
>;

export const SUPPORTED_AI_PROVIDERS = ['deepseek'] as const;

export type AiProviderId = (typeof SUPPORTED_AI_PROVIDERS)[number];

export interface AiModelSettings {
  provider: AiProviderId;
  apiKey: string;
  baseUrl: string | undefined;
  model: string;
}

export interface AiModelBinding {
  model: LanguageModel;
  structuredProviderOptions?: ProviderOptions;
}

export type AiModelFactory = (settings: AiModelSettings) => AiModelBinding;

export const AI_MODEL_FACTORY = Symbol('AI_MODEL_FACTORY');

export function isAiProviderId(value: string): value is AiProviderId {
  return SUPPORTED_AI_PROVIDERS.some((provider) => provider === value);
}

export const createAiModel: AiModelFactory = (settings) => {
  switch (settings.provider) {
    case 'deepseek': {
      const deepseek = createDeepSeek({
        apiKey: settings.apiKey,
        baseURL: settings.baseUrl,
      });
      return {
        model: deepseek(settings.model),
        structuredProviderOptions: {
          deepseek: { thinking: { type: 'disabled' } },
        },
      };
    }
  }
};
