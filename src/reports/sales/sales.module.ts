import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesService } from './sales.service';
import { AmazonSalesByAsin } from './entities/amazon-sales-by-asin.entity';
import { AmazonApiModule } from '../../amazon-api/amazon-api.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AmazonSalesByAsin]),
    AmazonApiModule,
  ],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
