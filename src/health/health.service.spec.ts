import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let queryRaw: jest.Mock;
  let service: HealthService;

  beforeEach(() => {
    queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    service = new HealthService({ $queryRaw: queryRaw } as unknown as PrismaService);
  });

  it('reports ok when postgres answers', async () => {
    await expect(service.check()).resolves.toEqual({ status: 'ok', postgres: 'up' });
  });

  it('throws 503 when the query fails', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    await expect(service.check()).rejects.toThrow(
      new ServiceUnavailableException('postgres is not reachable')
    );
  });
});
