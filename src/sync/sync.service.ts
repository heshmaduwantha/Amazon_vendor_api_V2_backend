import { Injectable, Logger, ConflictException, BadRequestException, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { SalesService } from '../reports/sales/sales.service';
import { InventoryService } from '../reports/inventory/inventory.service';
import { normalizeDateToUTC } from '../utils/date.util';
import { maskSecret } from '../utils/mask-secret.util';

export interface SyncStatus {
  isSyncing: boolean;
  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  lastSyncStatus: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS' | 'IDLE';
  lastError: string | null;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly SYNC_LOCK_KEY = 'amazon_sync_lock';
  private readonly SYNC_STATUS_KEY = 'amazon_sync_status';

  constructor(
    private readonly salesService: SalesService,
    private readonly inventoryService: InventoryService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async getSyncStatus(): Promise<SyncStatus> {
    const status = await this.cacheManager.get<SyncStatus>(this.SYNC_STATUS_KEY);
    return status || {
      isSyncing: false,
      lastSyncStartedAt: null,
      lastSyncFinishedAt: null,
      lastSyncStatus: 'IDLE',
      lastError: null,
    };
  }

  private async updateStatus(update: Partial<SyncStatus>) {
    const current = await this.getSyncStatus();
    await this.cacheManager.set(this.SYNC_STATUS_KEY, { ...current, ...update });
  }

  /**
   * Automates daily synchronization of Sales and Inventory data.
   * Runs daily at 02:00 AM UTC.
   */
  @Cron('0 2 * * *')
  async handleDailySync() {
    this.logger.log('CRON JOB STARTED: Daily Sync for Amazon SP-API');

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const yesterdayIso = yesterday.toISOString();
    const yesterdayStart = normalizeDateToUTC(yesterdayIso, 'start');
    const yesterdayEnd = normalizeDateToUTC(yesterdayIso, 'end');

    try {
      await this.executeSync(yesterdayStart, yesterdayEnd);
    } catch (error) {
      // Errors are already handled in executeSync
    }
  }

  /**
   * Executes the synchronization for a specific date range.
   * Includes a Global Sync Lock to prevent concurrent executions.
   */
  async executeSync(startDate: string, endDate: string) {
    // --- Date Sanity Validation ---
    const start = new Date(startDate);
    const end = new Date(endDate);
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - 30);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid date strings.');
    }
    if (end < start) {
      throw new BadRequestException('endDate cannot be earlier than startDate.');
    }
    if (start > now || end > now) {
      throw new BadRequestException('Sync dates cannot be in the future.');
    }
    if (start < thirtyDaysAgo) {
      throw new BadRequestException('Sync date range cannot be older than 30 days.');
    }

    // Distributed Lock Check
    const isLocked = await this.cacheManager.get(this.SYNC_LOCK_KEY);
    if (isLocked) {
      this.logger.warn('Synchronization is already in progress. Ignoring request.');
      throw new ConflictException('Sync process is already active.');
    }

    // Acquire Lock
    await this.cacheManager.set(this.SYNC_LOCK_KEY, 'true', 3600000);
    
    await this.updateStatus({
      isSyncing: true,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
    });

    const startTime = Date.now();
    this.logger.log(`Starting data sync for period: ${startDate} to ${endDate}`);

    try {
      this.logger.log('-> Syncing Sales Data...');
      await this.salesService.syncDailySales(startDate, endDate);

      this.logger.log('-> Syncing Inventory Data...');
      await this.inventoryService.syncDailyInventory(startDate, endDate);

      const durationMs = Date.now() - startTime;
      this.logger.log(`Full sync finished in ${durationMs}ms`);

      await this.updateStatus({
        isSyncing: false,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
      });
    } catch (error: any) {
      this.logger.error('Error during synchronization', error.stack || error.message);
      
      // Scrub sensitive data (tokens/keys) before saving to distributed status
      const maskedError = maskSecret(error?.message || 'Unknown sync error');
      
      await this.updateStatus({
        isSyncing: false,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskedError,
      });
      throw error;
    } finally {
      await this.cacheManager.del(this.SYNC_LOCK_KEY);
    }
  }
}
