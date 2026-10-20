import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export const IdempotencyKey = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const value = ctx.switchToHttp().getRequest<Request>().header('idempotency-key');

    if (value !== undefined && (value.length === 0 || value.length > 255)) {
      throw new BadRequestException('Idempotency-Key must be 1 to 255 characters');
    }

    return value;
  }
);
