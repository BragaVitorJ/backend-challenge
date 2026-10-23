import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import {
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
  isTransientError,
} from '../../domain/errors';
import { JsonLogger } from '../../infrastructure/observability/json-logger';
import { IS_PUBLIC } from './http';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    // Extension point: validate a bearer token against an external IdP (Keycloak or Zitadel).
    // This delivery leaves the guard as a no-op so authentication does not compete with the
    // financial invariants. See ARCHITECTURE.md.
    return true;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapException(exception);
    if (mapped.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.message : 'request failed');
    }
    response.status(mapped.status).json(mapped.body);
  }
}

function mapException(exception: unknown): { status: number; body: { error: string; message: string } } {
  if (exception instanceof InvalidPayloadError || exception instanceof InvalidMoneyError) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD', message: exception.message } };
  }
  if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
    return { status: 404, body: { error: exception.name, message: exception.message } };
  }
  if (exception instanceof DuplicateWalletError) {
    return { status: 409, body: { error: 'DUPLICATE_WALLET', message: exception.message } };
  }
  if (exception instanceof IdempotencyConflictError) {
    return { status: 409, body: { error: 'IDEMPOTENCY_CONFLICT', message: exception.message } };
  }
  if (exception instanceof TransientInfrastructureError || isTransientError(exception)) {
    return { status: 503, body: { error: 'TRANSIENT_FAILURE', message: 'temporary infrastructure failure' } };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, body: { error: 'HTTP_ERROR', message: exception.message } };
  }
  return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'internal error' } };
}
