import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SalesModule } from '../reports/sales/sales.module';
import { InventoryModule } from '../reports/inventory/inventory.module';
import { AmazonApiModule } from '../amazon-api/amazon-api.module';

@Module({
  imports: [SalesModule, InventoryModule, AmazonApiModule],
  providers: [SyncService],
  controllers: [SyncController]
})
export class SyncModule {}
