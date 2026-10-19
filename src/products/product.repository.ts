import { Injectable } from '@nestjs/common';
import { Prisma, Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActivePage(skip: number, take: number): Promise<[Product[], number]> {
    const where = { active: true };

    return await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
    ]);
  }

  async findActiveById(id: string): Promise<Product | null> {
    return await this.prisma.product.findFirst({ where: { id, active: true } });
  }

  async findActiveByIds(
    ids: string[],
    db: Prisma.TransactionClient = this.prisma
  ): Promise<Product[]> {
    return await db.product.findMany({ where: { id: { in: ids }, active: true } });
  }

  async reserveStock(
    id: string,
    quantity: number,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<boolean> {
    const { count } = await db.product.updateMany({
      where: { id, active: true, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    });

    return count === 1;
  }

  async upsertBySku(data: Prisma.ProductCreateInput): Promise<Product> {
    return await this.prisma.product.upsert({
      where: { sku: data.sku },
      create: data,
      update: data,
    });
  }
}
