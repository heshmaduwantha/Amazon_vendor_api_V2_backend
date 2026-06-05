import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SalesService } from '../reports/sales/sales.service';
import { InventoryService } from '../reports/inventory/inventory.service';
import { maskSecret } from '../utils/mask-secret.util';
import {
  AmazonWeekRange,
  getPreviousCompletedAmazonWeeks,
} from '../utils/amazon-week.util';
import {
  DEFAULT_INVENTORY_SCHEDULER_DAY,
  DEFAULT_INVENTORY_SCHEDULER_TIME,
  DEFAULT_INVENTORY_SCHEDULER_TIMEZONE,
  DEFAULT_SALES_SCHEDULER_DAY,
  DEFAULT_SALES_SCHEDULER_TIME,
  DEFAULT_SALES_SCHEDULER_TIMEZONE,
  WEEKDAY_LABELS,
  nextScheduledRunUtc,
  normalizeSchedulerConfig,
  schedulerDisplayLabel,
} from '../utils/scheduler-time.util';
import {
  SalesSchedulerSettingsEntity,
  SalesSchedulerWeekRange,
} from './entities/sales-scheduler-settings.entity';
import {
  InventorySchedulerSettingsEntity,
  InventorySchedulerWeekRange,
} from './entities/inventory-scheduler-settings.entity';
import { UpdateInventorySchedulerSettingsDto } from './dto/update-inventory-scheduler-settings.dto';
import { UpdateSalesSchedulerSettingsDto } from './dto/update-sales-scheduler-settings.dto';

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
  lastSyncPeriods?: AmazonWeekRange[] | null;
  nextScheduledAt: string;
}

export interface CombinedSyncStatus {
  sales: ReportSyncStatus;
  inventory: ReportSyncStatus;
  forecast: ReportSyncStatus;
}

export interface SalesSchedulerStatus {
  enabled: boolean;
  dayOfWeek: number;
  dayLabel: string;
  timeOfDay: string;
  timezone: string;
  scheduleLabel: string;
  nextScheduledAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: 'NEVER' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  lastRunError: string | null;
  lastRunWeekRanges: SalesSchedulerWeekRange[] | null;
  updatedAt: string | null;
}

export interface InventorySchedulerStatus {
  enabled: boolean;
  dayOfWeek: number;
  dayLabel: string;
  timeOfDay: string;
  timezone: string;
  scheduleLabel: string;
  nextScheduledAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: 'NEVER' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  lastRunError: string | null;
  lastRunWeekRanges: InventorySchedulerWeekRange[] | null;
  updatedAt: string | null;
}

// ─── Cache Keys ───────────────────────────────────────────────────────────────

const KEYS = {
  SALES_STATUS:      'sync_status_sales',
  SALES_LOCK:        'sync_lock_sales',
  SALES_CANCEL:      'sync_cancel_sales',
  INVENTORY_STATUS:  'sync_status_inventory',
  INVENTORY_LOCK:    'sync_lock_inventory',
  INVENTORY_CANCEL:  'sync_cancel_inventory',
  FORECAST_STATUS:   'sync_status_forecast',
  FORECAST_LOCK:     'sync_lock_forecast',
} as const;

/**
 * Thrown from a stage callback when a user has requested cancellation.
 * Caught in execute*Sync to mark the run as cancelled (not failed) and
 * swallow the rejection. Cancellation is cooperative: it takes effect at the
 * next pipeline stage boundary, since SP-API calls run to completion.
 */
class SyncCancelledError extends Error {
  constructor() {
    super('Sync cancelled by user.');
    this.name = 'SyncCancelledError';
  }
}

const ONE_DAY_MS  = 86_400_000;
const ONE_HOUR_MS =  3_600_000;

/**
 * How long a FAILED run keeps surfacing its error to clients. The raw failure is
 * still stored in cache (1-day TTL) for history, but after this window the public
 * status view reports it as cleared (IDLE, lastError=null) so the dashboard's 5s
 * poll auto-dismisses a stale error banner without a manual reload.
 */
const ERROR_VISIBLE_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Read-time view transform: once a FAILED run is older than ERROR_VISIBLE_MS (and
 * nothing is currently syncing), surface it as cleared while KEEPING accurate
 * lastRun / duration history (lastSyncStartedAt / lastSyncFinishedAt / lastSyncPeriod).
 * Pure — does not mutate the stored status. A new run starting overwrites raw status
 * anyway, which clears the error immediately.
 */
function applyErrorExpiry(status: ReportSyncStatus): ReportSyncStatus {
  if (status.lastSyncStatus !== 'FAILED' || status.isSyncing) return status;
  const finishedAt = status.lastSyncFinishedAt;
  if (!finishedAt) return status;
  if (Date.now() - new Date(finishedAt).getTime() < ERROR_VISIBLE_MS) return status;
  return {
    ...status,
    currentStage: SyncStage.IDLE,
    lastSyncStatus: 'IDLE',
    lastError: null,
  };
}

// ─── Next-Run Helpers ─────────────────────────────────────────────────────────

function defaultSalesNextScheduledAt(): string {
  return nextScheduledRunUtc({
    enabled: true,
    dayOfWeek: DEFAULT_SALES_SCHEDULER_DAY,
    timeOfDay: DEFAULT_SALES_SCHEDULER_TIME,
    timezone: DEFAULT_SALES_SCHEDULER_TIMEZONE,
  })?.toISOString() ?? '';
}

function defaultInventoryNextScheduledAt(): string {
  return nextScheduledRunUtc({
    enabled: true,
    dayOfWeek: DEFAULT_INVENTORY_SCHEDULER_DAY,
    timeOfDay: DEFAULT_INVENTORY_SCHEDULER_TIME,
    timezone: DEFAULT_INVENTORY_SCHEDULER_TIMEZONE,
  })?.toISOString() ?? '';
}

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
    sales:     defaultSalesNextScheduledAt(),
    inventory: defaultInventoryNextScheduledAt(),
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
  private salesScheduleTimer: NodeJS.Timeout | null = null;
  private inventoryScheduleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly salesService: SalesService,
    private readonly inventoryService: InventoryService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @InjectRepository(SalesSchedulerSettingsEntity)
    private readonly salesSchedulerRepo: Repository<SalesSchedulerSettingsEntity>,
    @InjectRepository(InventorySchedulerSettingsEntity)
    private readonly inventorySchedulerRepo: Repository<InventorySchedulerSettingsEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('SyncService initialized — dynamic Sales and Inventory schedulers registered.');
    await this.ensureSalesSchedulerSettings();
    await this.ensureInventorySchedulerSettings();
    await this.rescheduleSalesScheduler();
    await this.rescheduleInventoryScheduler();
    // ── MANUAL TRIGGER ──────────────────────────────────────────────────
    // Uncomment any line below to force-run that report on next server start.
    // Re-comment after use.
    // ────────────────────────────────────────────────────────────────────
    // void this.executeSalesSync();
    // void this.executeInventorySync();
    // void this.executeForecastSync();
  }

  // ── Sales Scheduler Settings ──────────────────────────────────────────────

  private defaultSalesSchedulerSettings(): SalesSchedulerSettingsEntity {
    return this.salesSchedulerRepo.create({
      id: 'sales',
      enabled: true,
      dayOfWeek: DEFAULT_SALES_SCHEDULER_DAY,
      timeOfDay: DEFAULT_SALES_SCHEDULER_TIME,
      timezone: DEFAULT_SALES_SCHEDULER_TIMEZONE,
      lastRunStatus: 'NEVER',
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunError: null,
      lastRunWeekRanges: null,
    });
  }

  private async ensureSalesSchedulerSettings(): Promise<SalesSchedulerSettingsEntity> {
    const existing = await this.salesSchedulerRepo.findOne({ where: { id: 'sales' } });
    if (existing) return existing;
    return this.salesSchedulerRepo.save(this.defaultSalesSchedulerSettings());
  }

  private toSalesSchedulerStatus(settings: SalesSchedulerSettingsEntity): SalesSchedulerStatus {
    const nextRun = nextScheduledRunUtc(settings);
    return {
      enabled: settings.enabled,
      dayOfWeek: settings.dayOfWeek,
      dayLabel: WEEKDAY_LABELS[settings.dayOfWeek],
      timeOfDay: settings.timeOfDay,
      timezone: settings.timezone,
      scheduleLabel: schedulerDisplayLabel(settings),
      nextScheduledAt: nextRun?.toISOString() ?? null,
      lastRunStartedAt: settings.lastRunStartedAt?.toISOString() ?? null,
      lastRunFinishedAt: settings.lastRunFinishedAt?.toISOString() ?? null,
      lastRunStatus: settings.lastRunStatus,
      lastRunError: settings.lastRunError,
      lastRunWeekRanges: settings.lastRunWeekRanges,
      updatedAt: settings.updatedAt?.toISOString() ?? null,
    };
  }

  async getSalesSchedulerStatus(): Promise<SalesSchedulerStatus> {
    return this.toSalesSchedulerStatus(await this.ensureSalesSchedulerSettings());
  }

  async updateSalesSchedulerSettings(
    dto: UpdateSalesSchedulerSettingsDto,
  ): Promise<SalesSchedulerStatus> {
    try {
      normalizeSchedulerConfig({
        enabled: dto.enabled ?? true,
        dayOfWeek: dto.dayOfWeek,
        timeOfDay: dto.timeOfDay,
        timezone: dto.timezone,
      });
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }

    const current = await this.ensureSalesSchedulerSettings();
    const saved = await this.salesSchedulerRepo.save({
      ...current,
      enabled: dto.enabled ?? current.enabled,
      dayOfWeek: dto.dayOfWeek,
      timeOfDay: dto.timeOfDay,
      timezone: dto.timezone.trim(),
    });

    await this.rescheduleSalesScheduler(saved);
    await this.updateSalesStatus({ nextScheduledAt: this.toSalesSchedulerStatus(saved).nextScheduledAt ?? '' });
    return this.toSalesSchedulerStatus(saved);
  }

  private async getSalesNextScheduledAt(): Promise<string> {
    const settings = await this.ensureSalesSchedulerSettings();
    return nextScheduledRunUtc(settings)?.toISOString() ?? '';
  }

  private async patchSalesScheduler(
    patch: Partial<SalesSchedulerSettingsEntity>,
  ): Promise<SalesSchedulerSettingsEntity> {
    const current = await this.ensureSalesSchedulerSettings();
    return this.salesSchedulerRepo.save({ ...current, ...patch });
  }

  private async rescheduleSalesScheduler(settings?: SalesSchedulerSettingsEntity): Promise<void> {
    if (this.salesScheduleTimer) {
      clearTimeout(this.salesScheduleTimer);
      this.salesScheduleTimer = null;
    }

    const schedulerSettings = settings ?? await this.ensureSalesSchedulerSettings();
    if (!schedulerSettings.enabled) {
      this.logger.log('[SalesScheduler] Disabled — no automatic Sales sync will be scheduled.');
      return;
    }

    const nextRun = nextScheduledRunUtc(schedulerSettings);
    if (!nextRun) {
      this.logger.warn('[SalesScheduler] Could not calculate next run; scheduler not armed.');
      return;
    }

    const delayMs = Math.max(nextRun.getTime() - Date.now(), 1_000);
    this.salesScheduleTimer = setTimeout(() => {
      void this.handleSalesScheduleTimer();
    }, delayMs);
    this.salesScheduleTimer.unref?.();

    this.logger.log(`[SalesScheduler] Next run: ${nextRun.toISOString()} (${schedulerDisplayLabel(schedulerSettings)})`);
  }

  private async handleSalesScheduleTimer(): Promise<void> {
    try {
      await this.handleWeeklySalesSync();
    } catch (error: any) {
      this.logger.error('[SalesScheduler] Scheduled run finished with an error.', error.stack || error.message);
    } finally {
      await this.rescheduleSalesScheduler();
    }
  }

  // ── Inventory Scheduler Settings ──────────────────────────────────────────

  private defaultInventorySchedulerSettings(): InventorySchedulerSettingsEntity {
    return this.inventorySchedulerRepo.create({
      id: 'inventory',
      enabled: true,
      dayOfWeek: DEFAULT_INVENTORY_SCHEDULER_DAY,
      timeOfDay: DEFAULT_INVENTORY_SCHEDULER_TIME,
      timezone: DEFAULT_INVENTORY_SCHEDULER_TIMEZONE,
      lastRunStatus: 'NEVER',
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunError: null,
      lastRunWeekRanges: null,
    });
  }

  private async ensureInventorySchedulerSettings(): Promise<InventorySchedulerSettingsEntity> {
    const existing = await this.inventorySchedulerRepo.findOne({ where: { id: 'inventory' } });
    if (existing) return existing;
    return this.inventorySchedulerRepo.save(this.defaultInventorySchedulerSettings());
  }

  private toInventorySchedulerStatus(settings: InventorySchedulerSettingsEntity): InventorySchedulerStatus {
    const nextRun = nextScheduledRunUtc(settings);
    return {
      enabled: settings.enabled,
      dayOfWeek: settings.dayOfWeek,
      dayLabel: WEEKDAY_LABELS[settings.dayOfWeek],
      timeOfDay: settings.timeOfDay,
      timezone: settings.timezone,
      scheduleLabel: schedulerDisplayLabel(settings),
      nextScheduledAt: nextRun?.toISOString() ?? null,
      lastRunStartedAt: settings.lastRunStartedAt?.toISOString() ?? null,
      lastRunFinishedAt: settings.lastRunFinishedAt?.toISOString() ?? null,
      lastRunStatus: settings.lastRunStatus,
      lastRunError: settings.lastRunError,
      lastRunWeekRanges: settings.lastRunWeekRanges,
      updatedAt: settings.updatedAt?.toISOString() ?? null,
    };
  }

  async getInventorySchedulerStatus(): Promise<InventorySchedulerStatus> {
    return this.toInventorySchedulerStatus(await this.ensureInventorySchedulerSettings());
  }

  async updateInventorySchedulerSettings(
    dto: UpdateInventorySchedulerSettingsDto,
  ): Promise<InventorySchedulerStatus> {
    try {
      normalizeSchedulerConfig({
        enabled: dto.enabled ?? true,
        dayOfWeek: dto.dayOfWeek,
        timeOfDay: dto.timeOfDay,
        timezone: dto.timezone,
      });
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }

    const current = await this.ensureInventorySchedulerSettings();
    const saved = await this.inventorySchedulerRepo.save({
      ...current,
      enabled: dto.enabled ?? current.enabled,
      dayOfWeek: dto.dayOfWeek,
      timeOfDay: dto.timeOfDay,
      timezone: dto.timezone.trim(),
    });

    await this.rescheduleInventoryScheduler(saved);
    await this.updateInventoryStatus({ nextScheduledAt: this.toInventorySchedulerStatus(saved).nextScheduledAt ?? '' });
    return this.toInventorySchedulerStatus(saved);
  }

  private async getInventoryNextScheduledAt(): Promise<string> {
    const settings = await this.ensureInventorySchedulerSettings();
    return nextScheduledRunUtc(settings)?.toISOString() ?? '';
  }

  private async patchInventoryScheduler(
    patch: Partial<InventorySchedulerSettingsEntity>,
  ): Promise<InventorySchedulerSettingsEntity> {
    const current = await this.ensureInventorySchedulerSettings();
    return this.inventorySchedulerRepo.save({ ...current, ...patch });
  }

  private async rescheduleInventoryScheduler(settings?: InventorySchedulerSettingsEntity): Promise<void> {
    if (this.inventoryScheduleTimer) {
      clearTimeout(this.inventoryScheduleTimer);
      this.inventoryScheduleTimer = null;
    }

    const schedulerSettings = settings ?? await this.ensureInventorySchedulerSettings();
    if (!schedulerSettings.enabled) {
      this.logger.log('[InventoryScheduler] Disabled — no automatic Inventory sync will be scheduled.');
      return;
    }

    const nextRun = nextScheduledRunUtc(schedulerSettings);
    if (!nextRun) {
      this.logger.warn('[InventoryScheduler] Could not calculate next run; scheduler not armed.');
      return;
    }

    const delayMs = Math.max(nextRun.getTime() - Date.now(), 1_000);
    this.inventoryScheduleTimer = setTimeout(() => {
      void this.handleInventoryScheduleTimer();
    }, delayMs);
    this.inventoryScheduleTimer.unref?.();

    this.logger.log(`[InventoryScheduler] Next run: ${nextRun.toISOString()} (${schedulerDisplayLabel(schedulerSettings)})`);
  }

  private async handleInventoryScheduleTimer(): Promise<void> {
    try {
      await this.handleWeeklyInventorySync();
    } catch (error: any) {
      this.logger.error('[InventoryScheduler] Scheduled run finished with an error.', error.stack || error.message);
    } finally {
      await this.rescheduleInventoryScheduler();
    }
  }

  // ── Public Status Getters ──────────────────────────────────────────────────

  // Public getters apply the error-expiry view so all clients (dashboard poll,
  // /sync/health) agree. Internal updaters read the raw stored status instead.

  async getSalesStatus(): Promise<ReportSyncStatus> {
    const status = await this.getRawSalesStatus();
    return applyErrorExpiry({
      ...status,
      nextScheduledAt: await this.getSalesNextScheduledAt(),
    });
  }

  async getInventoryStatus(): Promise<ReportSyncStatus> {
    const status = await this.getRawInventoryStatus();
    return applyErrorExpiry({
      ...status,
      nextScheduledAt: await this.getInventoryNextScheduledAt(),
    });
  }

  async getForecastStatus(): Promise<ReportSyncStatus> {
    return applyErrorExpiry(await this.getRawForecastStatus());
  }

  private async getRawSalesStatus(): Promise<ReportSyncStatus> {
    return (await this.cacheManager.get<ReportSyncStatus>(KEYS.SALES_STATUS))
      ?? initialStatus('sales');
  }

  private async getRawInventoryStatus(): Promise<ReportSyncStatus> {
    return (await this.cacheManager.get<ReportSyncStatus>(KEYS.INVENTORY_STATUS))
      ?? initialStatus('inventory');
  }

  private async getRawForecastStatus(): Promise<ReportSyncStatus> {
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
   * Sales report sync — default Wednesday 10:00 PM America/New_York.
   * The dynamic timer is configured from persisted settings; each scheduled run
   * reconciles the last three completed Amazon Sunday→Saturday weeks.
   */
  async handleWeeklySalesSync(): Promise<void> {
    const weeks = getPreviousCompletedAmazonWeeks(3);
    this.logger.log(
      `[SalesScheduler] Triggered. Weeks: ${weeks.map(w => `${w.label} ${w.startDate}→${w.endDate}`).join(', ')}`,
    );

    await this.patchSalesScheduler({
      lastRunStatus: 'RUNNING',
      lastRunStartedAt: new Date(),
      lastRunFinishedAt: null,
      lastRunError: null,
      lastRunWeekRanges: weeks,
    });

    try {
      await this.executeScheduledSalesWeeksSync(weeks);
      await this.patchSalesScheduler({
        lastRunStatus: 'SUCCESS',
        lastRunFinishedAt: new Date(),
        lastRunError: null,
        lastRunWeekRanges: weeks,
      });
    } catch (error: any) {
      await this.patchSalesScheduler({
        lastRunStatus: 'FAILED',
        lastRunFinishedAt: new Date(),
        lastRunError: maskSecret(error?.message || 'Unknown scheduler error'),
        lastRunWeekRanges: weeks,
      });
      throw error;
    }
  }

  /**
   * Inventory report sync — default Sunday 10:00 PM America/New_York.
   * The dynamic timer is configured from persisted settings; each scheduled run
   * reconciles the last three completed Amazon Sunday→Saturday weeks.
   */
  async handleWeeklyInventorySync(): Promise<void> {
    const weeks = getPreviousCompletedAmazonWeeks(3);
    this.logger.log(
      `[InventoryScheduler] Triggered. Weeks: ${weeks.map(w => `${w.label} ${w.startDate}→${w.endDate}`).join(', ')}`,
    );

    await this.patchInventoryScheduler({
      lastRunStatus: 'RUNNING',
      lastRunStartedAt: new Date(),
      lastRunFinishedAt: null,
      lastRunError: null,
      lastRunWeekRanges: weeks,
    });

    try {
      await this.executeScheduledInventoryWeeksSync(weeks);
      await this.patchInventoryScheduler({
        lastRunStatus: 'SUCCESS',
        lastRunFinishedAt: new Date(),
        lastRunError: null,
        lastRunWeekRanges: weeks,
      });
    } catch (error: any) {
      await this.patchInventoryScheduler({
        lastRunStatus: 'FAILED',
        lastRunFinishedAt: new Date(),
        lastRunError: maskSecret(error?.message || 'Unknown scheduler error'),
        lastRunWeekRanges: weeks,
      });
      throw error;
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
    await this.cacheManager.del(KEYS.SALES_CANCEL); // clear any stale cancel flag

    await this.updateSalesStatus({
      isSyncing: true,
      currentStage: SyncStage.REQUESTING_REPORT,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
      lastSyncPeriod: { startDate, endDate },
      lastSyncPeriods: null,
      nextScheduledAt: await this.getSalesNextScheduledAt(),
      stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
    });

    this.logger.log(`[Sales] Starting sync [${trigger}] — ${startDate} → ${endDate}`);
    const t0 = Date.now();

    try {
      await this.salesService.syncDailySales(
        startDate,
        endDate,
        async (stage) => await this.updateSalesStage(stage as SyncStage),
        async () => {
          if (await this.cacheManager.get(KEYS.SALES_CANCEL)) throw new SyncCancelledError();
        },
      );

      const durationMs = Date.now() - t0;
      this.logger.log(`[Sales] Sync complete in ${durationMs}ms`);

      await this.updateSalesStatus({
        isSyncing: false,
        currentStage: SyncStage.COMPLETED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
        nextScheduledAt: await this.getSalesNextScheduledAt(),
      });
    } catch (error: any) {
      if (error instanceof SyncCancelledError) {
        this.logger.warn('[Sales] Sync cancelled by user.');
        await this.updateSalesStatus({
          isSyncing: false,
          currentStage: SyncStage.IDLE,
          lastSyncFinishedAt: new Date().toISOString(),
          lastSyncStatus: 'IDLE',
          lastError: 'Sync cancelled by user.',
          nextScheduledAt: await this.getSalesNextScheduledAt(),
        });
        return; // cancellation is not a failure — swallow
      }
      this.logger.error('[Sales] Sync failed', error.stack || error.message);
      await this.updateSalesStatus({
        isSyncing: false,
        currentStage: SyncStage.FAILED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskSecret(error?.message || 'Unknown error'),
        nextScheduledAt: await this.getSalesNextScheduledAt(),
      });
      throw error;
    } finally {
      await this.cacheManager.del(KEYS.SALES_LOCK);
      await this.cacheManager.del(KEYS.SALES_CANCEL);
    }
  }

  private async executeScheduledSalesWeeksSync(weeks: AmazonWeekRange[]): Promise<void> {
    if (!weeks.length) throw new BadRequestException('At least one Amazon week is required.');

    const chronologicalWeeks = [...weeks].reverse();
    const combinedPeriod = {
      startDate: chronologicalWeeks[0].startDate,
      endDate: chronologicalWeeks[chronologicalWeeks.length - 1].endDate,
    };

    const isLocked = await this.cacheManager.get(KEYS.SALES_LOCK);
    if (isLocked) {
      this.logger.warn('[SalesScheduler] Sales sync already in progress — scheduled run skipped.');
      throw new ConflictException('Sales sync is already active.');
    }

    await this.cacheManager.set(KEYS.SALES_LOCK, 'true', ONE_HOUR_MS * 8);
    await this.cacheManager.del(KEYS.SALES_CANCEL);

    await this.updateSalesStatus({
      isSyncing: true,
      currentStage: SyncStage.REQUESTING_REPORT,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
      lastSyncPeriod: combinedPeriod,
      lastSyncPeriods: weeks,
      nextScheduledAt: await this.getSalesNextScheduledAt(),
      stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
    });

    const t0 = Date.now();
    this.logger.log(`[SalesScheduler] Starting 3-week Sales sync — ${combinedPeriod.startDate} → ${combinedPeriod.endDate}`);

    try {
      for (const week of chronologicalWeeks) {
        if (await this.cacheManager.get(KEYS.SALES_CANCEL)) throw new SyncCancelledError();

        await this.updateSalesStatus({
          currentStage: SyncStage.REQUESTING_REPORT,
          lastSyncPeriod: { startDate: week.startDate, endDate: week.endDate },
          stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
        });

        this.logger.log(`[SalesScheduler] Syncing ${week.label}: ${week.startDate} → ${week.endDate}`);
        await this.salesService.syncDailySales(
          week.startDate,
          week.endDate,
          async (stage) => await this.updateSalesStage(stage as SyncStage),
          async () => {
            if (await this.cacheManager.get(KEYS.SALES_CANCEL)) throw new SyncCancelledError();
          },
        );
      }

      const durationMs = Date.now() - t0;
      this.logger.log(`[SalesScheduler] 3-week Sales sync complete in ${durationMs}ms`);

      await this.updateSalesStatus({
        isSyncing: false,
        currentStage: SyncStage.COMPLETED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
        lastSyncPeriod: combinedPeriod,
        lastSyncPeriods: weeks,
        nextScheduledAt: await this.getSalesNextScheduledAt(),
      });
    } catch (error: any) {
      if (error instanceof SyncCancelledError) {
        this.logger.warn('[SalesScheduler] Sales sync cancelled by user.');
        await this.updateSalesStatus({
          isSyncing: false,
          currentStage: SyncStage.IDLE,
          lastSyncFinishedAt: new Date().toISOString(),
          lastSyncStatus: 'IDLE',
          lastError: 'Sync cancelled by user.',
          lastSyncPeriod: combinedPeriod,
          lastSyncPeriods: weeks,
          nextScheduledAt: await this.getSalesNextScheduledAt(),
        });
        throw error;
      }

      this.logger.error('[SalesScheduler] Sales sync failed', error.stack || error.message);
      await this.updateSalesStatus({
        isSyncing: false,
        currentStage: SyncStage.FAILED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskSecret(error?.message || 'Unknown error'),
        lastSyncPeriod: combinedPeriod,
        lastSyncPeriods: weeks,
        nextScheduledAt: await this.getSalesNextScheduledAt(),
      });
      throw error;
    } finally {
      await this.cacheManager.del(KEYS.SALES_LOCK);
      await this.cacheManager.del(KEYS.SALES_CANCEL);
    }
  }

  private async executeScheduledInventoryWeeksSync(weeks: AmazonWeekRange[]): Promise<void> {
    if (!weeks.length) throw new BadRequestException('At least one Amazon week is required.');

    const chronologicalWeeks = [...weeks].reverse();
    const combinedPeriod = {
      startDate: chronologicalWeeks[0].startDate,
      endDate: chronologicalWeeks[chronologicalWeeks.length - 1].endDate,
    };

    const isLocked = await this.cacheManager.get(KEYS.INVENTORY_LOCK);
    if (isLocked) {
      this.logger.warn('[InventoryScheduler] Inventory sync already in progress — scheduled run skipped.');
      throw new ConflictException('Inventory sync is already active.');
    }

    await this.cacheManager.set(KEYS.INVENTORY_LOCK, 'true', ONE_HOUR_MS * 8);
    await this.cacheManager.del(KEYS.INVENTORY_CANCEL);

    await this.updateInventoryStatus({
      isSyncing: true,
      currentStage: SyncStage.REQUESTING_REPORT,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
      lastSyncPeriod: combinedPeriod,
      lastSyncPeriods: weeks,
      nextScheduledAt: await this.getInventoryNextScheduledAt(),
      stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
    });

    const t0 = Date.now();
    this.logger.log(`[InventoryScheduler] Starting 3-week Inventory sync — ${combinedPeriod.startDate} → ${combinedPeriod.endDate}`);

    try {
      for (const week of chronologicalWeeks) {
        if (await this.cacheManager.get(KEYS.INVENTORY_CANCEL)) throw new SyncCancelledError();

        await this.updateInventoryStatus({
          currentStage: SyncStage.REQUESTING_REPORT,
          lastSyncPeriod: { startDate: week.startDate, endDate: week.endDate },
          stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
        });

        this.logger.log(`[InventoryScheduler] Syncing ${week.label}: ${week.startDate} → ${week.endDate}`);
        await this.inventoryService.syncDailyInventory(
          week.startDate,
          week.endDate,
          async (stage) => await this.updateInventoryStage(stage as SyncStage),
          async () => {
            if (await this.cacheManager.get(KEYS.INVENTORY_CANCEL)) throw new SyncCancelledError();
          },
        );
      }

      const durationMs = Date.now() - t0;
      this.logger.log(`[InventoryScheduler] 3-week Inventory sync complete in ${durationMs}ms`);

      await this.updateInventoryStatus({
        isSyncing: false,
        currentStage: SyncStage.COMPLETED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
        lastSyncPeriod: combinedPeriod,
        lastSyncPeriods: weeks,
        nextScheduledAt: await this.getInventoryNextScheduledAt(),
      });
    } catch (error: any) {
      if (error instanceof SyncCancelledError) {
        this.logger.warn('[InventoryScheduler] Inventory sync cancelled by user.');
        await this.updateInventoryStatus({
          isSyncing: false,
          currentStage: SyncStage.IDLE,
          lastSyncFinishedAt: new Date().toISOString(),
          lastSyncStatus: 'IDLE',
          lastError: 'Sync cancelled by user.',
          lastSyncPeriod: combinedPeriod,
          lastSyncPeriods: weeks,
          nextScheduledAt: await this.getInventoryNextScheduledAt(),
        });
        throw error;
      }

      this.logger.error('[InventoryScheduler] Inventory sync failed', error.stack || error.message);
      await this.updateInventoryStatus({
        isSyncing: false,
        currentStage: SyncStage.FAILED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskSecret(error?.message || 'Unknown error'),
        lastSyncPeriod: combinedPeriod,
        lastSyncPeriods: weeks,
        nextScheduledAt: await this.getInventoryNextScheduledAt(),
      });
      throw error;
    } finally {
      await this.cacheManager.del(KEYS.INVENTORY_LOCK);
      await this.cacheManager.del(KEYS.INVENTORY_CANCEL);
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
    await this.cacheManager.del(KEYS.INVENTORY_CANCEL); // clear any stale cancel flag

    await this.updateInventoryStatus({
      isSyncing: true,
      currentStage: SyncStage.REQUESTING_REPORT,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncStatus: 'IN_PROGRESS',
      lastError: null,
      lastSyncPeriod: { startDate, endDate },
      lastSyncPeriods: null,
      nextScheduledAt: await this.getInventoryNextScheduledAt(),
      stageTimestamps: { [SyncStage.REQUESTING_REPORT]: new Date().toISOString() },
    });

    this.logger.log(`[Inventory] Starting sync [${trigger}] — ${startDate} → ${endDate}`);
    const t0 = Date.now();

    try {
      await this.inventoryService.syncDailyInventory(
        startDate,
        endDate,
        async (stage) => await this.updateInventoryStage(stage as SyncStage),
        async () => {
          if (await this.cacheManager.get(KEYS.INVENTORY_CANCEL)) throw new SyncCancelledError();
        },
      );

      const durationMs = Date.now() - t0;
      this.logger.log(`[Inventory] Sync complete in ${durationMs}ms`);

      await this.updateInventoryStatus({
        isSyncing: false,
        currentStage: SyncStage.COMPLETED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'SUCCESS',
        nextScheduledAt: await this.getInventoryNextScheduledAt(),
      });
    } catch (error: any) {
      if (error instanceof SyncCancelledError) {
        this.logger.warn('[Inventory] Sync cancelled by user.');
        await this.updateInventoryStatus({
          isSyncing: false,
          currentStage: SyncStage.IDLE,
          lastSyncFinishedAt: new Date().toISOString(),
          lastSyncStatus: 'IDLE',
          lastError: 'Sync cancelled by user.',
          nextScheduledAt: await this.getInventoryNextScheduledAt(),
        });
        return; // cancellation is not a failure — swallow
      }
      this.logger.error('[Inventory] Sync failed', error.stack || error.message);
      await this.updateInventoryStatus({
        isSyncing: false,
        currentStage: SyncStage.FAILED,
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncStatus: 'FAILED',
        lastError: maskSecret(error?.message || 'Unknown error'),
        nextScheduledAt: await this.getInventoryNextScheduledAt(),
      });
      throw error;
    } finally {
      await this.cacheManager.del(KEYS.INVENTORY_LOCK);
      await this.cacheManager.del(KEYS.INVENTORY_CANCEL);
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
    // Cooperative cancellation checkpoint — abort before entering the next stage.
    if (await this.cacheManager.get(KEYS.SALES_CANCEL)) {
      throw new SyncCancelledError();
    }
    this.logger.log(`[Sales] Stage → ${stage}`);
    const current = await this.getRawSalesStatus();
    await this.updateSalesStatus({
      currentStage: stage,
      stageTimestamps: { ...current.stageTimestamps, [stage]: new Date().toISOString() },
    });
  }

  private async updateInventoryStage(stage: SyncStage): Promise<void> {
    // Cooperative cancellation checkpoint — abort before entering the next stage.
    if (await this.cacheManager.get(KEYS.INVENTORY_CANCEL)) {
      throw new SyncCancelledError();
    }
    this.logger.log(`[Inventory] Stage → ${stage}`);
    const current = await this.getRawInventoryStatus();
    await this.updateInventoryStatus({
      currentStage: stage,
      stageTimestamps: { ...current.stageTimestamps, [stage]: new Date().toISOString() },
    });
  }

  // ── Cancellation ────────────────────────────────────────────────────────────

  /**
   * Request cancellation of an in-flight Sales sync. Cooperative: sets a flag
   * that the pipeline checks at the next stage boundary, then releases the lock
   * (cleared in execute*Sync's finally). No-op if nothing is running.
   */
  async cancelSalesSync(): Promise<{ cancelled: boolean; message: string }> {
    const isLocked = await this.cacheManager.get(KEYS.SALES_LOCK);
    if (!isLocked) {
      return { cancelled: false, message: 'No sales sync is currently running.' };
    }
    await this.cacheManager.set(KEYS.SALES_CANCEL, 'true', ONE_HOUR_MS * 4);
    this.logger.warn('[Sales] Cancellation requested — will stop at the next stage boundary.');
    return { cancelled: true, message: 'Cancellation requested. The sync will stop at the next stage.' };
  }

  /**
   * Request cancellation of an in-flight Inventory sync. Same cooperative model
   * as cancelSalesSync.
   */
  async cancelInventorySync(): Promise<{ cancelled: boolean; message: string }> {
    const isLocked = await this.cacheManager.get(KEYS.INVENTORY_LOCK);
    if (!isLocked) {
      return { cancelled: false, message: 'No inventory sync is currently running.' };
    }
    await this.cacheManager.set(KEYS.INVENTORY_CANCEL, 'true', ONE_HOUR_MS * 4);
    this.logger.warn('[Inventory] Cancellation requested — will stop at the next stage boundary.');
    return { cancelled: true, message: 'Cancellation requested. The sync will stop at the next stage.' };
  }

  private async updateSalesStatus(patch: Partial<ReportSyncStatus>): Promise<void> {
    const current = await this.getRawSalesStatus();
    await this.cacheManager.set(KEYS.SALES_STATUS, { ...current, ...patch }, ONE_DAY_MS);
  }

  private async updateInventoryStatus(patch: Partial<ReportSyncStatus>): Promise<void> {
    const current = await this.getRawInventoryStatus();
    await this.cacheManager.set(KEYS.INVENTORY_STATUS, { ...current, ...patch }, ONE_DAY_MS);
  }

  private async updateForecastStatus(patch: Partial<ReportSyncStatus>): Promise<void> {
    const current = await this.getRawForecastStatus();
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
