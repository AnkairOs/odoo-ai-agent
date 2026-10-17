import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  stepCountIs,
  TypeValidationError,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import {
  AI_MODEL_FACTORY,
  isAiProviderId,
  type AiModelBinding,
  type AiModelFactory,
} from './ai-model.factory.js';
import type { TokenUsage } from './ai-provider.interface.js';
import type {
  AiFailure,
  AiMessage,
  StructuredRequest,
  StructuredResult,
  ToolLoopRequest,
  ToolLoopResult,
} from './ai.types.js';

const DEFAULT_PROVIDER = 'deepseek';
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_STEPS = 4;
const MAX_RETRIES = 1;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly binding: AiModelBinding | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(AI_MODEL_FACTORY) private readonly modelFactory: AiModelFactory,
  ) {
    this.timeoutMs = this.readTimeoutMs();
    this.binding = this.createBinding();
  }

  isEnabled(): boolean {
    return this.binding !== undefined;
  }

  async generateStructured<T>(
    request: StructuredRequest<T>,
  ): Promise<StructuredResult<T>> {
    const binding = this.binding;
    if (!binding) {
      return disabled();
    }
    return this.withTimeout(request.timeoutMs, async (abortSignal) => {
      const result = await generateText({
        model: binding.model,
        system: request.system,
        messages: toModelMessages(request.messages),
        output: Output.object({ schema: request.schema }),
        providerOptions: binding.structuredProviderOptions,
        maxRetries: MAX_RETRIES,
        abortSignal,
      });
      return {
        ok: true,
        object: result.output,
        usage: toTokenUsage(result.totalUsage),
      };
    });
  }

  async generateWithTools(request: ToolLoopRequest): Promise<ToolLoopResult> {
    const binding = this.binding;
    if (!binding) {
      return disabled();
    }
    const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
    return this.withTimeout(
      request.timeoutMs,
      async (abortSignal): Promise<ToolLoopResult> => {
        const result = await generateText({
          model: binding.model,
          system: request.system,
          messages: toModelMessages(request.messages),
          tools: request.tools,
          stopWhen: stepCountIs(maxSteps),
          maxRetries: MAX_RETRIES,
          abortSignal,
        });
        const toolsExecuted = result.steps.flatMap((step) =>
          step.content
            .filter(
              (part) =>
                part.type === 'tool-result' || part.type === 'tool-error',
            )
            .map((part) => part.toolName),
        );
        if (result.text.trim() === '') {
          return {
            ok: false,
            reason: 'invalid_output',
            detail: `no final answer after ${result.steps.length} step(s), finish reason ${result.finishReason}`,
          };
        }
        return {
          ok: true,
          text: result.text,
          toolsExecuted,
          usage: toTokenUsage(result.totalUsage),
        };
      },
    );
  }

  private async withTimeout<T>(
    timeoutMs: number | undefined,
    run: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T | AiFailure> {
    const controller = new AbortController();
    const effectiveTimeoutMs = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      return await run(controller.signal);
    } catch (error) {
      const failure = controller.signal.aborted
        ? timeoutFailure(effectiveTimeoutMs)
        : classifyError(error);
      this.logger.warn(`AI call failed: ${failure.reason} (${failure.detail})`);
      return failure;
    } finally {
      clearTimeout(timer);
    }
  }

  private createBinding(): AiModelBinding | undefined {
    if (this.configService.get<string>('AI_ENABLED') !== 'true') {
      return undefined;
    }
    const provider =
      this.configService.get<string>('AI_PROVIDER') || DEFAULT_PROVIDER;
    if (!isAiProviderId(provider)) {
      this.logger.error(`AI disabled: unknown AI_PROVIDER "${provider}"`);
      return undefined;
    }
    const apiKey = this.configService.get<string>('DEEPSEEK_API_KEY');
    if (!apiKey) {
      this.logger.warn('AI disabled: DEEPSEEK_API_KEY is not set');
      return undefined;
    }
    try {
      return this.modelFactory({
        provider,
        apiKey,
        baseUrl:
          this.configService.get<string>('DEEPSEEK_BASE_URL') || undefined,
        model: this.configService.get<string>('AI_MODEL') || DEFAULT_MODEL,
      });
    } catch (error) {
      this.logger.error(`AI disabled: model setup failed (${describe(error)})`);
      return undefined;
    }
  }

  private readTimeoutMs(): number {
    const parsed = Number(this.configService.get<string>('AI_TIMEOUT_MS'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }
}

function disabled(): AiFailure {
  return { ok: false, reason: 'disabled', detail: 'AI is disabled' };
}

function timeoutFailure(timeoutMs: number): AiFailure {
  return {
    ok: false,
    reason: 'timeout',
    detail: `no answer within ${timeoutMs}ms`,
  };
}

function classifyError(error: unknown): AiFailure {
  const isInvalidOutput =
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    JSONParseError.isInstance(error);
  return {
    ok: false,
    reason: isInvalidOutput ? 'invalid_output' : 'provider_error',
    detail: describe(error),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toModelMessages(messages: AiMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
  };
}
