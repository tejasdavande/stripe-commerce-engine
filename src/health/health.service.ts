import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { errorReason } from '../common/error-reason';

export interface HealthStatus {
  status: 'ok';
  postgres: 'up';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.warn(`postgres health check failed: ${errorReason(error)}`);
      throw new ServiceUnavailableException('postgres is not reachable');
    }

    return { status: 'ok', postgres: 'up' };
  }
}
