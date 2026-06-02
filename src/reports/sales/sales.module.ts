import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { AmazonSalesByAsin } from './entities/amazon-sales-by-asin.entity';
import { AmazonSalesAggregate } from './entities/amazon-sales-aggregate.entity';
import { AmazonApiModule } from '../../amazon-api/amazon-api.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AmazonSalesByAsin, AmazonSalesAggregate]),
    AmazonApiModule,
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
