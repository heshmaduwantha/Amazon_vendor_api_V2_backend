import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AmazonSalesAggregate } from './src/reports/sales/entities/amazon-sales-aggregate.entity';
import { Repository } from 'typeorm';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const repo = app.get<Repository<AmazonSalesAggregate>>(getRepositoryToken(AmazonSalesAggregate));

  const res = await repo.find({
    order: { startDate: 'DESC' },
    take: 7,
    select: ['startDate', 'endDate']
  });

  console.log(res);
  await app.close();
  process.exit(0);
}

bootstrap();
