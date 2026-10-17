import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboundMessage } from './kapso-payload.js';
import { RelayService } from './relay.service.js';
import { RelayJob, RelayStore } from './relay.store.js';

const DEFAULT_TENANT_ID = 'default';

@Injectable()
export class RelayJobProcessor
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RelayJobProcessor.name);
  private running = false;
  private stopped = false;
  private drained: Promise<void> = Promise.resolve();

  constructor(
    private readonly configService: ConfigService,
    private readonly store: RelayStore,
    private readonly relay: RelayService,
  ) {}

  onApplicationBootstrap() {
    this.store.resumeInterruptedJobs();
    this.kick();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.whenIdle();
  }

  enqueue(messages: InboundMessage[]): void {
    const tenantId =
      this.configService.get<string>('RELAY_TENANT_ID') || DEFAULT_TENANT_ID;
    this.store.enqueueJob(tenantId, messages);
    this.kick();
  }

  async whenIdle(): Promise<void> {
    while (this.running) {
      await this.drained;
    }
  }

  private kick() {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const job = this.store.claimNextJob();
        if (!job) {
          return;
        }
        await this.run(job);
      }
    } catch (error) {
      this.logger.error(`Relay job queue stopped: ${describe(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async run(job: RelayJob): Promise<void> {
    try {
      await this.relay.handle(job.messages);
      this.store.completeJob(job.id);
    } catch (error) {
      this.logger.error(`Relay job #${job.id} failed: ${describe(error)}`);
      this.store.failJob(job.id, describe(error));
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
