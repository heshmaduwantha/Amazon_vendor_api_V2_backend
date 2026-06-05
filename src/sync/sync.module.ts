import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SalesModule } from '../reports/sales/sales.module';
import { InventoryModule } from '../reports/inventory/inventory.module';
import { AmazonApiModule } from '../amazon-api/amazon-api.module';
import { SalesSchedulerSettingsEntity } from './entities/sales-scheduler-settings.entity';
import { InventorySchedulerSettingsEntity } from './entities/inventory-scheduler-settings.entity';

@Module({
  // AmazonApiModule exports AmazonApiService → available in SyncController for quota/health endpoint
  imports: [TypeOrmModule.forFeature([SalesSchedulerSettingsEntity, InventorySchedulerSettingsEntity]), SalesModule, InventoryModule, AmazonApiModule],
  providers: [SyncService],
  controllers: [SyncController],
})
export class SyncModule {}
