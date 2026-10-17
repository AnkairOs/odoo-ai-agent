import { Module } from '@nestjs/common';
import { AI_MODEL_FACTORY, createAiModel } from './ai-model.factory.js';
import { AiService } from './ai.service.js';

@Module({
  providers: [
    { provide: AI_MODEL_FACTORY, useValue: createAiModel },
    AiService,
  ],
  exports: [AiService],
})
export class AiModule {}
