import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { SyncService } from './sync.service';
import { AmazonApiService } from '../amazon-api/amazon-api.service';
import { ManualSyncDto } from './dto/manual-sync.dto';
import { getLastSevenDays } from '../utils/date.util';
import { UpdateInventorySchedulerSettingsDto } from './dto/update-inventory-scheduler-settings.dto';
import { UpdateSalesSchedulerSettingsDto } from './dto/update-sales-scheduler-settings.dto';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly amazonApiService: AmazonApiService,
  ) {}

  // ── Status Endpoints ──────────────────────────────────────────────────────

  /** Combined status for all reports — polled by frontend dashboard every 5s */
  @Get('status')
  async getCombinedStatus() {
    return this.syncService.getCombinedStatus();
  }

  @Get('scheduler/sales')
  async getSalesSchedulerStatus() {
    return this.syncService.getSalesSchedulerStatus();
  }

  @Put('scheduler/sales')
  async updateSalesSchedulerSettings(@Body() body: UpdateSalesSchedulerSettingsDto) {
    return this.syncService.updateSalesSchedulerSettings(body);
  }

  @Get('scheduler/inventory')
  async getInventorySchedulerStatus() {
    return this.syncService.getInventorySchedulerStatus();
  }

  @Put('scheduler/inventory')
  async updateInventorySchedulerSettings(@Body() body: UpdateInventorySchedulerSettingsDto) {
    return this.syncService.updateInventorySchedulerSettings(body);
  }

  @Get('status/sales')
  async getSalesStatus() {
    return this.syncService.getSalesStatus();
  }

  @Get('status/inventory')
  async getInventoryStatus() {
    return this.syncService.getInventoryStatus();
  }

  @Get('status/forecast')
  async getForecastStatus() {
    return this.syncService.getForecastStatus();
  }

  // ── Health / Quota Endpoint ───────────────────────────────────────────────
  /**
   * GET /sync/health
   * Returns a combined view of:
   *   - Sync status for both report types (Phase 1)
   *   - Amazon SP-API quota status per endpoint group (Phase 2)
   *   - Rate limiter configuration currently in use
   *
   * Used by the frontend "System Health" panel.
   */
  @Get('health')
  async getSystemHealth() {
    const [combined, quotaStatus, rateLimitConfig, salesScheduler, inventoryScheduler] = await Promise.all([
      this.syncService.getCombinedStatus(),
      this.amazonApiService.getAllQuotaStatus(),
      Promise.resolve(this.amazonApiService.getRateLimitConfig()),
      this.syncService.getSalesSchedulerStatus(),
      this.syncService.getInventorySchedulerStatus(),
    ]);

    // Build a human-friendly quota summary
    const quotaSummary = quotaStatus.map(q => ({
      group:              q.group,
      status:             q.status,
      consecutive429s:    q.consecutive429Count,
      lastSuccess:        q.lastSuccessAt,
      last429:            q.last429At,
      cooldownUntil:      q.cooldownUntil,
      nextAllowedAt:      q.nextAllowedAt,
      rateLimitHeader:    q.lastRateLimitHeader,
      calculatedMinDelay: q.calculatedMinDelayMs ? `${q.calculatedMinDelayMs}ms` : null,
    }));

    // Derive overall API health
    const anyIn429Cooldown = quotaStatus.some(q => q.status === 'COOLDOWN');
    const total429s         = quotaStatus.reduce((acc, q) => acc + q.consecutive429Count, 0);

    return {
      timestamp: new Date().toISOString(),
      apiHealth: {
        status:          anyIn429Cooldown ? 'COOLDOWN' : 'OK',
        total429Errors:  total429s,
        message:         anyIn429Cooldown
          ? '⚠️  One or more quota groups are in cooldown. Requests are queued.'
          : '✅ All quota groups operational.',
      },
      rateLimiters: {
        createReport:      `1 req / ${rateLimitConfig.createReport.minTime / 1000}s`,
        getReport:         `1 req / ${rateLimitConfig.getReport.minTime / 1000}s (polling)`,
        getReportDocument: `1 req / ${rateLimitConfig.getReportDocument.minTime / 1000}s`,
        concurrency:       'max 1 per group (no parallel SP-API calls)',
      },
      quotaGroups:  quotaSummary,
      syncStatus:   combined,
      salesScheduler,
      inventoryScheduler,
    };
  }

  // ── Manual Trigger Endpoints ──────────────────────────────────────────────

  /**
   * POST /sync/manual/sales
   * Trigger Sales sync manually.
   * Body: { startDate?, endDate? } — defaults to last 7 days if omitted.
   */
  @Post('manual/sales')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualSalesSync(@Body() body: Partial<ManualSyncDto>) {
    const { startDate, endDate } = body.startDate && body.endDate
      ? (body as ManualSyncDto)
      : getLastSevenDays();

    this.syncService.executeSalesSync(startDate, endDate, 'manual').catch((err) => {
      // Error already logged inside service — silent here to avoid unhandled rejection
      console.error('[ManualSales] sync error:', err?.message);
    });

    return {
      message:   `Sales sync initiated for ${startDate} → ${endDate}.`,
      startDate,
      endDate,
      tip:       'Poll GET /sync/status/sales for live progress.',
    };
  }

  /**
   * POST /sync/manual/inventory
   * Trigger Inventory sync manually.
   * Body: { startDate?, endDate? } — defaults to last 7 days if omitted.
   */
  @Post('manual/inventory')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualInventorySync(@Body() body: Partial<ManualSyncDto>) {
    const { startDate, endDate } = body.startDate && body.endDate
      ? (body as ManualSyncDto)
      : getLastSevenDays();

    this.syncService.executeInventorySync(startDate, endDate, 'manual').catch((err) => {
      console.error('[ManualInventory] sync error:', err?.message);
    });

    return {
      message:   `Inventory sync initiated for ${startDate} → ${endDate}.`,
      startDate,
      endDate,
      tip:       'Poll GET /sync/status/inventory for live progress.',
    };
  }

  /**
   * POST /sync/manual/forecast
   * Trigger Forecast sync manually.
   */
  @Post('manual/forecast')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualForecastSync() {
    this.syncService.executeForecastSync().catch(() => {});

    return {
      message: 'Forecast sync initiated.',
      tip:     'Poll GET /sync/status/forecast for live progress.',
    };
  }

  // ── Cancellation Endpoints ────────────────────────────────────────────────

  /**
   * POST /sync/cancel/sales
   * Request cancellation of an in-flight Sales sync (cooperative — stops at the
   * next pipeline stage boundary). Returns { cancelled, message }.
   */
  @Post('cancel/sales')
  @HttpCode(HttpStatus.OK)
  async cancelSalesSync() {
    return this.syncService.cancelSalesSync();
  }

  /**
   * POST /sync/cancel/inventory
   * Request cancellation of an in-flight Inventory sync.
   */
  @Post('cancel/inventory')
  @HttpCode(HttpStatus.OK)
  async cancelInventorySync() {
    return this.syncService.cancelInventorySync();
  }

  /**
   * POST /sync/manual
   * Trigger both Sales + Inventory sequentially.
   * Kept for backward compatibility.
   */
  @Post('manual')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualBothSync(@Body() body: Partial<ManualSyncDto>) {
    const { startDate, endDate } = body.startDate && body.endDate
      ? (body as ManualSyncDto)
      : getLastSevenDays();

    (async () => {
      try { await this.syncService.executeSalesSync(startDate, endDate, 'manual'); } catch { /* logged inside */ }
      try { await this.syncService.executeInventorySync(startDate, endDate, 'manual'); } catch { /* logged inside */ }
    })();

    return {
      message:   `Full sync (sales → inventory) initiated for ${startDate} → ${endDate}.`,
      startDate,
      endDate,
    };
  }
}
