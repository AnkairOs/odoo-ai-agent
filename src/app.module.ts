import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { OdooModule } from './odoo/odoo.module.js';
import { RelayModule } from './relay/relay.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.example'],
    }),
    OdooModule,
    RelayModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
