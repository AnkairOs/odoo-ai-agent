import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

const SIGNATURE_HEADER = 'x-webhook-signature';

@Injectable()
export class KapsoSignatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const secret = this.configService.get<string>('KAPSO_WEBHOOK_SECRET');
    const signature = req.headers[SIGNATURE_HEADER];

    if (!secret || !req.rawBody || typeof signature !== 'string') {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!this.matches(req.rawBody, signature, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return true;
  }

  private matches(rawBody: Buffer, signature: string, secret: string): boolean {
    const expected = Buffer.from(
      createHmac('sha256', secret).update(rawBody).digest('hex'),
      'utf8',
    );
    const received = Buffer.from(signature, 'utf8');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}
