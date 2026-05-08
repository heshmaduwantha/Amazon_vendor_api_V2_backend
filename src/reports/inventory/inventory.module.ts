import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryService } from './inventory.service';
import { AmazonInventoryByAsin } from './entities/amazon-inventory-by-asin.entity';
import { AmazonApiModule } from '../../amazon-api/amazon-api.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AmazonInventoryByAsin]),
    AmazonApiModule,
  ],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
