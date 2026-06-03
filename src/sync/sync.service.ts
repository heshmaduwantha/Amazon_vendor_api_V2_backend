import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { SalesService } from '../reports/sales/sales.service';
import { InventoryService } from '../reports/inventory/inventory.service';
import { normalizeDateToUTC, getLastSevenDays, getLastCompletedWeek } from '../utils/date.util';
import { maskSecret } from '../utils/mask-secret.util';
import { pacificDayStartUtc, pacificDayEndUtc, addPacificDays } from '../utils/spapi-date.util';

// ─── Stage Enum ──────────────────────────────────────────────────────────────

export enum SyncStage {
  IDLE               = 'IDLE',
  REQUESTING_REPORT  = 'REQUESTING_REPORT',
  REPORT_IN_QUEUE    = 'REPORT_IN_QUEUE',
  REPORT_IN_PROGRESS = 'REPORT_IN_PROGRESS',
  FETCHING_DOCUMENT  = 'FETCHING_DOCUMENT',
  DOWNLOADING_REPORT = 'DOWNLOADING_REPORT',
  PARSING_REPORT     = 'PARSING_REPORT',
  UPSERTING_DATABASE = 'UPSERTING_DATABASE',
  COMPLETED          = 'COMPLETED',
  FAILED             = 'FAILED',
}

// ─── Status Shape ─────────────────────────────────────────────────────────────

export interface ReportSyncStatus {
  reportType: 'sales' | 'inventory' | 'forecast';
  isSyncing: boolean;
  currentStage: SyncStage;
  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  lastSyncStatus: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS' | 'IDLE';
  lastError: string | null;
  stageTimestamps: Record<string, string>;
  lastSyncPeriod: { startDate: string; endDate: string } | null;
  nextScheduledAt: string;
}

export interface CombinedSyncStatus {
  sales: ReportSyncStatus;
  inventory: ReportSyncStatus;
  forecast: ReportSyncStatus;
}

// ─── Cache Keys ───────────────────────────────────────────────────────────────

const KEYS = {
  SALES_STATUS:      'sync_status_sales',
  SALES_LOCK:        'sync_lock_sales',
  INVENTORY_STATUS:  'sync_status_inventory',
  INVENTORY_LOCK:    'sync_lock_inventory',
  FORECAST_STATUS:   'sync_status_forecast',
  FORECAST_LOCK:     'sync_lock_forecast',
} as const;

const ONE_DAY_MS  = 86_400_000;
const ONE_HOUR_MS =  3_600_000;

// ─── Date window constants ────────────────────────────────────────────────────

/** Days to lag behind today before including a day in the sync window.
 *  Amazon needs a few days to finalize Vendor data. */
const LAG_DAYS = 4;

/** How many days back to reconcile on each sync run. */
const RECONCILIATION_DAYS = 14;

// ─── Next-Run Helpers ─────────────────────────────────────────────────────────

function nextWeekday(targetDay: number /* 0=Sun … 6=Sat */, hourUTC = 2): string {
  const now = new Date();
  const nowDay = now.getUTCDay();
  let daysUntil = (targetDay - nowDay + 7) % 7;
  if (daysUntil === 0 && now.getUTCHours() >= hourUTC) daysUntil = 7;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil, hourUTC, 0, 0));
  return next.toISOString();
}

function initialStatus(reportType: 'sales' | 'inventory' | 'forecast'): ReportSyncStatus {
  const nextMap: Record<string, string> = {
    sales:     nextWeekday(3),  // Wednesday
    inventory: nextWeekday(0),  // Sunday
    forecast:  nextWeekday(5),  // Friday
  };
  return {
    reportType,
    isSyncing: false,
    currentStage: SyncStage.IDLE,
    lastSyncStartedAt: null,
    lastSyncFinishedAt: null,
    lastSyncStatus: 'IDLE',
    lastError: null,
    stageTimestamps: {},
    lastSyncPeriod: null,
    nextScheduledAt: nextMap[reportType],
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly salesService: SalesService,
    private readonly inventoryService: InventoryService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  onModuleInit() {
    this.logger.log('SyncService initialized — cron jobs registered.');
    // ── MANUAL TRIGGER ──────────────────────────────────────────────────
    // Uncomment any line below to force-run that report on next server start.
    // Re-comment after use.
    // ────────────────────────────────────────────────────────────────────
    // void this.executeSalesSync();
    // void this.executeInventorySync();
    // void this.executeForecastSync();
  }

  // ── Public Status Getters ──────────────────────────────────────────────────

  async getSalesStatus(): Promise<ReportSyncStatus> {
    return (await this.cacheManager.get<ReportSyncStatus>(KEYS.SALES_STATUS))
      ?? initialStatus('sales');
  }

  async getInventoryStatus(): Promise<ReportSyncStatus> {
    return (await this.cacheManager.get<ReportSyncStatus>(KEYS.INVENTORY_STATUS))
      ?? initialStatus('inventory');
  }

  async getForecastStatus(): Promise<ReportSyncStatus> {
    return (await this.cacheManager.get<ReportSyncStatus>(KEYS.FORECAST_STATUS))
      ?? initialStatus('forecast');
  }

  async getCombinedStatus(): Promise<CombinedSyncStatus> {
    const [sales, inventory, forecast] = await Promise.all([
      this.getSalesStatus(),
      this.getInventoryStatus(),
      this.getForecastStatus(),
    ]);
    return { sales, inventory, forecast };
  }

  // ── Scheduled Cron Jobs ────────────────────────────────────────────────────

  /**
   * Sales report sync — every Wednesday at midnight Pacific
   * Cron: '0 0 * * 3'
   *
   * Uses getLastCompletedWeek(3) — the last Mon→Sun week where
   * Sunday is at least 3 days in the past, giving Amazon time to finalize
   * the data. This matches what Vendor Central portal shows.
   */
  // @Cron('0 0 * * 3')
  async handleWeeklySalesSync(): Promise<void> {
    this.logger.log('[CRON] Weekly Sales Sync triggered (Wednesday)');
    const { startDate, endDate } = getLastCompletedWeek(3);
    this.logger.log(`[CRON] Sales sync window (lag=3d): ${startDate} → ${endDate}`);
    try {
      await this.executeSalesSync(startDate, endDate, 'cron');
    } catch {
      // already logged inside executeSalesSync
    }
  }

  /**
   * Inventory report sync — every Sunday at midnight Pacific
   * Cron: '0 0 * * 0'
   *
   * Uses getLastCompletedWeek(3) — same lag-buffer logic as sales.
   */
  // @Cron('0 0 * * 0')
  async handleWeeklyInventorySync(): Promise<void> {
    this.logger.log('[CRON] Weekly Inventory Sync triggered (Sunday)');
    const { startDate, endDate } = getLastCompletedWeek(3);
    this.logger.log(`[CRON] Inventory sync window (lag=3d): ${startDate} → ${endDate}`);
    try {
      await this.executeInventorySync(startDate, endDate, 'cron');
    } catch {
      // already logged inside executeInventorySync
    }
  }

  /**
   * Forecast report sync — every Friday at midnight Pacific
   * Cron: '0 0 * * 5'
   * DISABLED — Forecast sync not active. Uncomment @Cron to re-enable.
   */
  // @Cron('0 0 * * 5')
  async handleWeeklyForecastSync(): Promise<void> {
    this.logger.log('[CRON] Weekly Forecast Sync triggered (Friday)');
    try {
      await this.executeForecastSync();
    } catch {
      // already logged inside executeForecastSync
    }
  }

  // ── Sales Sync ────────────────────────────────────────────────────────────

  async executeSalesSync(
    startDate: string,
    endDate: string,
    trigger: 'cron' | 'manual' = 'manual',
  ): Promise<void> {
    ({ startDate, endDate } = this.validateDateRange(startDate, endDate));

    const isLocked = await this.cacheManager.get(KEYS.SALES_LOCK);
    if (isLocked) {
      this.logger.warn('[Sales] Sync already in progress — skipping.');
      throw new ConflictException('Sales sync is already active.');
    }

    await this.cacheManager.set(KEYS.SALES_LOCK, 'true', ONE_HOUR_MS * 4);

    await this.updateSalesStatus({
      isSyncing: true,
      currentStage: SyncStage.REQUESTING_REPORT,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
      lastSyncPeriod: { startDate, endDate },
      nextScheduledAt: nextWeekday(3),
      stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
    });

    this.logger.log(`[Sales] Starting sync [${trigger}] — ${startDate} → ${endDate}`);
    const t0 = Date.now();

    try {
      await this.salesService.syncDailySales(
        startDate,
        endDate,
        async (stage) => await this.updateSalesStage(stage as SyncStage),
      );

      const durationMs = Date.now() - t0;
      this.logger.log(`[Sales] Sync complete in ${durationMs}ms`);

      await this.updateSalesStatus({
        isSyncing: false,
        currentStage: SyncStage.COMPLETED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
        nextScheduledAt: nextWeekday(3),
      });
    } catch (error: any) {
      this.logger.error('[Sales] Sync failed', error.stack || error.message);
      await this.updateSalesStatus({
        isSyncing: false,
        currentStage: SyncStage.FAILED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskSecret(error?.message || 'Unknown error'),
        nextScheduledAt: nextWeekday(3),
      });
      throw error;
    } finally {
      await this.cacheManager.del(KEYS.SALES_LOCK);
    }
  }

  // ── Inventory Sync ────────────────────────────────────────────────────────

  async executeInventorySync(
    startDate: string,
    endDate: string,
    trigger: 'cron' | 'manual' = 'manual',
  ): Promise<void> {
    ({ startDate, endDate } = this.validateDateRange(startDate, endDate));

    const isLocked = await this.cacheManager.get(KEYS.INVENTORY_LOCK);
    if (isLocked) {
      this.logger.warn('[Inventory] Sync already in progress — skipping.');
      throw new ConflictException('Inventory sync is already active.');
    }

    await this.cacheManager.set(KEYS.INVENTORY_LOCK, 'true', ONE_HOUR_MS * 4);

    await this.updateInventoryStatus({
      isSyncing: true,
      currentStage: SyncStage.REQUESTING_REPORT,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
      lastSyncPeriod: { startDate, endDate },
      nextScheduledAt: nextWeekday(0),
      stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
    });

    this.logger.log(`[Inventory] Starting sync [${trigger}] — ${startDate} → ${endDate}`);
    const t0 = Date.now();

    try {
      await this.inventoryService.syncDailyInventory(
        startDate,
        endDate,
        async (stage) => await this.updateInventoryStage(stage as SyncStage),
      );

      const durationMs = Date.now() - t0;
      this.logger.log(`[Inventory] Sync complete in ${durationMs}ms`);

      await this.updateInventoryStatus({
        isSyncing: false,
        currentStage: SyncStage.COMPLETED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
        nextScheduledAt: nextWeekday(0),
      });
    } catch (error: any) {
      this.logger.error('[Inventory] Sync failed', error.stack || error.message);
      await this.updateInventoryStatus({
        isSyncing: false,
        currentStage: SyncStage.FAILED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskSecret(error?.message || 'Unknown error'),
        nextScheduledAt: nextWeekday(0),
      });
      throw error;
    } finally {
      await this.cacheManager.del(KEYS.INVENTORY_LOCK);
    }
  }

  // ── Forecast Sync ─────────────────────────────────────────────────────────

  /**
   * Forecast sync stub.
   * Forecast reports follow the legacy SP-API direct pattern and are not yet
   * wired through this SyncService. This method logs the intent and updates
   * status so the dashboard shows the correct next-scheduled time.
   *
   * To enable: implement SP-API GET_VENDOR_FORECASTING_REPORT flow here,
   * similar to executeSalesSync / executeInventorySync above.
   */
  async executeForecastSync(): Promise<void> {
    this.logger.log(
      '[Forecast] executeForecastSync called — forecast currently uses direct SP-API from legacy pattern. ' +
      'No DB upsert performed by this service.',
    );
    await this.updateForecastStatus({
      isSyncing: false,
      currentStage: SyncStage.IDLE,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncFinishedAt: new Date().toISOString(),
      lastSyncStatus: 'IDLE',
      nextScheduledAt: nextWeekday(5),
    });
  }

  // ── Private Status Updaters ────────────────────────────────────────────────

  private async updateSalesStage(stage: SyncStage): Promise<void> {
    this.logger.log(`[Sales] Stage → ${stage}`);
    const current = await this.getSalesStatus();
    await this.updateSalesStatus({
      currentStage: stage,
      stageTimestamps: { ...current.stageTimestamps, [stage]: new Date().toISOString() },
    });
  }

  private async updateInventoryStage(stage: SyncStage): Promise<void> {
    this.logger.log(`[Inventory] Stage → ${stage}`);
    const current = await this.getInventoryStatus();
    await this.updateInventoryStatus({
      currentStage: stage,
      stageTimestamps: { ...current.stageTimestamps, [stage]: new Date().toISOString() },
    });
  }

  private async updateSalesStatus(patch: Partial<ReportSyncStatus>): Promise<void> {
    const current = await this.getSalesStatus();
    await this.cacheManager.set(KEYS.SALES_STATUS, { ...current, ...patch }, ONE_DAY_MS);
  }

  private async updateInventoryStatus(patch: Partial<ReportSyncStatus>): Promise<void> {
    const current = await this.getInventoryStatus();
    await this.cacheManager.set(KEYS.INVENTORY_STATUS, { ...current, ...patch }, ONE_DAY_MS);
  }

  private async updateForecastStatus(patch: Partial<ReportSyncStatus>): Promise<void> {
    const current = await this.getForecastStatus();
    await this.cacheManager.set(KEYS.FORECAST_STATUS, { ...current, ...patch }, ONE_DAY_MS);
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  private validateDateRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
    const start = new Date(startDate);
    let   end   = new Date(endDate);
    const now   = new Date();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(now.getDate() - 365);

    if (isNaN(start.getTime()) || isNaN(end.getTime()))
      throw new BadRequestException('startDate and endDate must be valid ISO date strings.');
    if (end < start)
      throw new BadRequestException('endDate cannot be earlier than startDate.');
    if (start < ninetyDaysAgo)
      throw new BadRequestException('Sync date range cannot be older than 90 days.');

    // Clamp endDate to today if in future — don't reject, just trim
    if (end > now) {
      end = now;
      endDate = end.toISOString().split('T')[0];
      this.logger.warn(`[Validate] endDate was in future — clamped to today: ${endDate}`);
    }
    if (start > now)
      throw new BadRequestException('startDate cannot be in the future.');

    return { startDate, endDate };
  }
}
