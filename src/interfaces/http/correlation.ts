import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/ids';
import { LogContext } from '../../infrastructure/observability/json-logger';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(@Inject(LogContext) private readonly context: LogContext) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header('x-correlation-id');
    const correlationId = incoming && KEY_PATTERN.test(incoming) ? incoming : newId();
    response.setHeader('x-correlation-id', correlationId);
    this.context.run({ correlationId }, () => next());
  }
}
