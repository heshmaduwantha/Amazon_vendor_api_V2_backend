import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AmazonInventoryByAsin } from './entities/amazon-inventory-by-asin.entity';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';
// ─── Query result shapes ──────────────────────────────────────────────────────

export interface InventorySnapshotSummary {
  totalAsins:          number;
  totalSellableUnits:  number;
  totalUnsellableUnits: number;
  avgOosRatePct:       number;   // average sourceable OOS rate across rows, as %
  totalOpenPoUnits:    number;
}

export interface InventorySnapshotResult {
  period:    { startDate: string; endDate: string };
  records:   AmazonInventoryByAsin[];
  summary:   InventorySnapshotSummary;
  rowCount:  number;
}

/**
 * Vendor Inventory Report Options — built from env vars (same as sales).
 * VENDOR_DISTRIBUTOR_VIEW  = SOURCING | MANUFACTURING   (default: SOURCING)
 * VENDOR_SELLING_PROGRAM   = RETAIL | FRESH             (default: RETAIL)
 * VENDOR_REPORT_PERIOD     = DAY | WEEK | MONTH         (default: DAY)
 */
function buildInventoryReportOptions(configService: import('@nestjs/config').ConfigService) {
  return {
    reportPeriod:    configService.get<string>('VENDOR_REPORT_PERIOD')    || 'DAY',
    distributorView: configService.get<string>('VENDOR_DISTRIBUTOR_VIEW') || 'SOURCING',
    sellingProgram:  configService.get<string>('VENDOR_SELLING_PROGRAM')  || 'RETAIL',
  };
}

const BATCH_SIZE = 500;
const MAX_INVENTORY_DAY_REPORT_DAYS = 15;

interface DateRange {
  startDate: string;
  endDate: string;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(AmazonInventoryByAsin)
    private readonly inventoryRepo: Repository<AmazonInventoryByAsin>,
    private readonly amazonApiService: AmazonApiService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Inventory sync flow (Phase 3 — matches legacy approach):
   *
   * PRIMARY  — List Amazon's pre-generated DONE reports for the date range.
   * FALLBACK — On-demand creation if no pre-generated reports exist.
   */
  async syncDailyInventory(
    startDate: string,
    endDate: string,
    onStageChange?: (stage: any) => Promise<void>,
    checkCancelled?: () => Promise<void>,
  ): Promise<void> {
    const normalizedStartDate = this.amazonApiService.normalizeDate(startDate, 'start');
    const normalizedEndDate   = this.amazonApiService.normalizeDate(endDate,   'end');
    const marketplaceId = this.configService.get<string>('MARKETPLACE_ID') || 'ATVPDKIKX0DER';
    const reportType    = 'GET_VENDOR_INVENTORY_REPORT';

    this.logger.log(`[Inventory] Syncing ${normalizedStartDate} → ${normalizedEndDate}`);

    // ── Step 1: look for reports Amazon has already generated ─────────────────
    if (onStageChange) await onStageChange('REQUESTING_REPORT');

    const reportOptions = buildInventoryReportOptions(this.configService);
    this.logger.log(`[Inventory] reportOptions: ${JSON.stringify(reportOptions)}`);

    // Match Sales behavior: create on-demand reports for the requested range.
    // Amazon caps DAY inventory reports at 15 days, so monthly manual pulls are
    // split into smaller on-demand chunks and upserted into one logical result.
    const forceOnDemand = true;
    const reportRanges = this.getInventoryReportRanges(
      startDate,
      endDate,
      reportOptions.reportPeriod,
    );

    let totalRows = 0;

    if (!forceOnDemand) {
      const existingReports = await this.amazonApiService.listExistingReports(
        reportType, marketplaceId, normalizedStartDate, normalizedEndDate,
      );

      const documentIds = existingReports
        .map((r: any) => r.reportDocumentId)
        .filter(Boolean)
        .slice(0, 3); // 3 most-recent only — each getReportDocument = 1 quota slot; burst limit = 15

      if (documentIds.length > 0) {
        this.logger.log(`[Inventory] Found ${existingReports.length} pre-generated report(s) — processing ${documentIds.length} most recent.`);
        totalRows += await this.downloadAndUpsertDocuments(
          documentIds,
          normalizedStartDate,
          normalizedEndDate,
          onStageChange,
        );
        this.logger.log(`[Inventory] Sync complete. Total rows: ${totalRows}`);
        return;
      }
    }

    for (const range of reportRanges) {
      // ── Fallback: create a new on-demand report ─────────────────────────────
      if (!forceOnDemand) {
        this.logger.warn(`[Inventory] No pre-generated reports found. Attempting on-demand creation...`);
      } else {
        this.logger.log(`[Inventory] Creating on-demand report for ${range.startDate} → ${range.endDate}.`);
      }

      const reportStartDate = this.amazonApiService.normalizeDate(range.startDate, 'start');
      const reportEndDate = this.amazonApiService.normalizeDate(range.endDate, 'end');

      const { reportId } = await this.amazonApiService.createReport(
        reportType, [marketplaceId],
        reportStartDate, reportEndDate,
        reportOptions,
      );
      this.logger.log(`[Inventory] Report created. reportId: ${reportId}`);

      const docId = await this.pollUntilDone(reportId, onStageChange, checkCancelled);
      this.logger.log(`[Inventory] Report DONE. documentId: ${docId}`);

      totalRows += await this.downloadAndUpsertDocuments(
        [docId],
        range.startDate,
        range.endDate,
        onStageChange,
      );
    }

    this.logger.log(`[Inventory] Sync complete. Total rows: ${totalRows}`);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private getInventoryReportRanges(
    startDate: string,
    endDate: string,
    reportPeriod: string,
  ): DateRange[] {
    const startDay = startDate.slice(0, 10);
    const endDay = endDate.slice(0, 10);
    if (reportPeriod !== 'DAY') return [{ startDate: startDay, endDate: endDay }];

    const ranges: DateRange[] = [];
    const current = new Date(`${startDay}T00:00:00Z`);
    const end = new Date(`${endDay}T00:00:00Z`);

    if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(`Invalid Inventory report date range: ${startDate} → ${endDate}`);
    }

    while (current <= end) {
      const chunkStart = new Date(current);
      const chunkEnd = new Date(current);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + MAX_INVENTORY_DAY_REPORT_DAYS - 1);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());

      ranges.push({
        startDate: this.toIsoDate(chunkStart),
        endDate: this.toIsoDate(chunkEnd),
      });

      current.setTime(chunkEnd.getTime());
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return ranges;
  }

  private toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private async downloadAndUpsertDocuments(
    documentIds: string[],
    startDate: string,
    endDate: string,
    onStageChange?: (stage: any) => Promise<void>,
  ): Promise<number> {
    let totalRows = 0;

    for (const docId of documentIds) {
      if (onStageChange) await onStageChange('FETCHING_DOCUMENT');
      const doc = await this.amazonApiService.getReportDocument(docId);

      if (onStageChange) await onStageChange('DOWNLOADING_REPORT');
      const rawContent = await this.amazonApiService.downloadAndParseReport(
        doc.url, doc.compressionAlgorithm,
      );

      if (onStageChange) await onStageChange('PARSING_REPORT');

      const inventoryByAsin: any[] = rawContent?.inventoryByAsin ?? (Array.isArray(rawContent) ? rawContent : []);
      totalRows += inventoryByAsin.length;

      if (onStageChange) await onStageChange('UPSERTING_DATABASE');
      await this.upsertInventoryByAsin(inventoryByAsin, startDate, endDate);

      this.logger.log(`[Inventory] Document ${docId} — rows: ${inventoryByAsin.length}`);
    }

    return totalRows;
  }

  private async pollUntilDone(
    reportId: string,
    onStageChange?: (stage: any) => Promise<void>,
    checkCancelled?: () => Promise<void>,
    maxAttempts = 30,
    intervalMs = 10000,
  ): Promise<string> {
    let lastReportStatus = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Cooperative cancellation — checked every poll iteration. Throws if cancelled.
      if (checkCancelled) await checkCancelled();

      const report = await this.amazonApiService.getReport(reportId);
      const processingStatus: string = report.processingStatus;

      if (processingStatus !== lastReportStatus && onStageChange) {
        if (['SUBMITTED', 'IN_QUEUE'].includes(processingStatus)) {
          await onStageChange('REPORT_IN_QUEUE');
        } else if (processingStatus === 'IN_PROGRESS') {
          await onStageChange('REPORT_IN_PROGRESS');
        }
        lastReportStatus = processingStatus;
      }

      this.logger.debug(`[Inventory] Poll ${attempt}/${maxAttempts} — reportId: ${reportId}, status: ${processingStatus}`);

      if (processingStatus === 'DONE') {
        return report.reportDocumentId;
      }

      if (['CANCELLED', 'FATAL'].includes(processingStatus)) {
        const message = await this.buildHumanReadableReportFailure(reportId, processingStatus, report);
        this.logger.error(`[Inventory] ${message}`);
        throw new Error(message);
      }

      // Interruptible wait: sleep in 1s slices, checking for cancellation between
      // them so a Stop request lands within ~1s instead of after the full interval.
      const slices = Math.ceil(intervalMs / 1000);
      for (let s = 0; s < slices; s++) {
        if (checkCancelled) await checkCancelled();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`[Inventory] Report ${reportId} did not complete within ${maxAttempts * intervalMs / 1000}s`);
  }

  private async buildHumanReadableReportFailure(
    reportId: string,
    processingStatus: string,
    report: any,
  ): Promise<string> {
    const prefix = processingStatus === 'FATAL'
      ? `Inventory report ${reportId} failed at Amazon.`
      : `Inventory report ${reportId} was cancelled by Amazon.`;

    if (processingStatus !== 'FATAL') {
      return `${prefix} Try again after checking the selected date range.`;
    }

    if (!report?.reportDocumentId) {
      return `${prefix} Amazon did not attach a readable error document. Check the date range and inventory report options, then try again.`;
    }

    try {
      this.logger.log(`[Inventory] Downloading FATAL error document: ${report.reportDocumentId}`);
      const errDoc = await this.amazonApiService.getReportDocument(report.reportDocumentId);
      const errBody = await this.amazonApiService.downloadAndParseReport(errDoc.url, errDoc.compressionAlgorithm);
      this.logger.error(`[Inventory] FATAL error document contents:\n${JSON.stringify(errBody, null, 2)}`);

      const amazonReason = this.humanizeReportErrorDocument(errBody);
      if (amazonReason) return `${prefix} Amazon says: ${amazonReason}`;
    } catch (docErr: any) {
      this.logger.warn(`[Inventory] Could not fetch FATAL error document: ${docErr.message}`);
    }

    return `${prefix} Could not read Amazon's error document. Check the date range and inventory report options, then try again.`;
  }

  private humanizeReportErrorDocument(body: unknown): string | null {
    const messages = this.collectReportErrorMessages(body)
      .map(message => message.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (messages.length === 0) return null;

    const uniqueMessages = [...new Set(messages)];
    const text = uniqueMessages.join(' ');
    return text.length > 600 ? `${text.slice(0, 597)}...` : text;
  }

  private collectReportErrorMessages(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string') return [value];
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (Array.isArray(value)) return value.flatMap(item => this.collectReportErrorMessages(item));
    if (typeof value !== 'object') return [];

    const record = value as Record<string, unknown>;
    const code = this.stringifyErrorPart(record.code ?? record.Code);
    const descriptionParts = [
      this.stringifyErrorPart(record.message ?? record.Message ?? record.errorMessage),
      this.stringifyErrorPart(record.reason ?? record.description),
      this.stringifyErrorPart(record.details ?? record.detail),
    ].filter(Boolean);
    const directMessage = [
      code ? `${code}:` : null,
      descriptionParts.join(' '),
    ].filter(Boolean).join(' ');

    const nested = [
      record.errors,
      record.error,
      record.errorDetails,
      record.issues,
      record.failures,
    ].flatMap(item => this.collectReportErrorMessages(item));

    return directMessage ? [directMessage, ...nested] : nested;
  }

  private stringifyErrorPart(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  private async upsertInventoryByAsin(records: any[], startDate: string, endDate: string): Promise<void> {
    if (!records.length) {
      this.logger.debug(`[Inventory] No records to upsert.`);
      return;
    }

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const entities = chunk.map(record => this.inventoryRepo.create({
        // Phase 3 fix: use each record's own date from the API response.
        // Before this fix every record in the 7-day batch shared the same
        // (start_date, end_date) PK — only 1 row per ASIN was ever saved.
        startDate: record.startDate ?? startDate,
        endDate:   record.endDate   ?? endDate,
        asin: record.asin,
        sourceableProductOutOfStockRate: record.sourceableProductOutOfStockRate ?? null,
        procurableProductOutOfStockRate: record.procurableProductOutOfStockRate ?? null,
        openPurchaseOrderUnits: record.openPurchaseOrderUnits ?? null,
        receiveFillRate: record.receiveFillRate ?? null,
        averageVendorLeadTimeDays: record.averageVendorLeadTimeDays ?? null,
        sellThroughRate: record.sellThroughRate ?? null,
        unfilledCustomerOrderedUnits: record.unfilledCustomerOrderedUnits ?? null,
        vendorConfirmationRate: record.vendorConfirmationRate ?? null,
        netReceivedInventoryCostAmount: record.netReceivedInventoryCost?.amount ?? record.netReceivedInventoryCost ?? null,
        netReceivedInventoryCostCurrencyCode: record.netReceivedInventoryCost?.currencyCode ?? null,
        netReceivedInventoryUnits: record.netReceivedInventoryUnits ?? null,
        sellableOnHandInventoryCostAmount: record.sellableOnHandInventoryCost?.amount ?? record.sellableOnHandInventoryCost ?? null,
        sellableOnHandInventoryCostCurrencyCode: record.sellableOnHandInventoryCost?.currencyCode ?? null,
        sellableOnHandInventoryUnits: record.sellableOnHandInventoryUnits ?? null,
        unsellableOnHandInventoryCostAmount: record.unsellableOnHandInventoryCost?.amount ?? record.unsellableOnHandInventoryCost ?? null,
        unsellableOnHandInventoryCostCurrencyCode: record.unsellableOnHandInventoryCost?.currencyCode ?? null,
        unsellableOnHandInventoryUnits: record.unsellableOnHandInventoryUnits ?? null,
        aged90PlusDaysSellableInventoryCostAmount: record.aged90PlusDaysSellableInventoryCost?.amount ?? record.aged90PlusDaysSellableInventoryCost ?? null,
        aged90PlusDaysSellableInventoryCostCurrencyCode: record.aged90PlusDaysSellableInventoryCost?.currencyCode ?? null,
        aged90PlusDaysSellableInventoryUnits: record.aged90PlusDaysSellableInventoryUnits ?? null,
      }));

      await this.inventoryRepo
        .createQueryBuilder()
        .insert()
        .into(AmazonInventoryByAsin)
        .values(entities)
        .orUpdate(
          [
            'sourceable_product_out_of_stock_rate',
            'procurable_product_out_of_stock_rate',
            'open_purchase_order_units',
            'receive_fill_rate',
            'average_vendor_lead_time_days',
            'sell_through_rate',
            'unfilled_customer_ordered_units',
            'vendor_confirmation_rate',
            'net_received_inventory_cost_amount',
            'net_received_inventory_cost_currency_code',
            'net_received_inventory_units',
            'sellable_on_hand_inventory_cost_amount',
            'sellable_on_hand_inventory_cost_currency_code',
            'sellable_on_hand_inventory_units',
            'unsellable_on_hand_inventory_cost_amount',
            'unsellable_on_hand_inventory_cost_currency_code',
            'unsellable_on_hand_inventory_units',
            'aged_90_plus_days_sellable_inventory_cost_amount',
            'aged_90_plus_days_sellable_inventory_cost_currency_code',
            'aged_90_plus_days_sellable_inventory_units',
          ],
          ['start_date', 'end_date', 'asin']
        )
        .execute();
      
      this.logger.debug(`[Inventory] Batch ${Math.floor(i / BATCH_SIZE) + 1} processed.`);
    }
  }

  // ── Phase 3: Data Tally Query ─────────────────────────────────────────────

  /**
   * Returns all inventory records in the given date range plus an aggregated
   * summary.  Used by the Data Tally panel to compare against Vendor Central.
   */
  async queryInventorySnapshot(
    startDate: string,
    endDate: string,
  ): Promise<InventorySnapshotResult> {
    const records = await this.inventoryRepo
      .createQueryBuilder('i')
      .where('i.startDate >= :startDate', { startDate })
      .andWhere('i.endDate <= :endDate',   { endDate })
      .orderBy('i.startDate', 'ASC')
      .addOrderBy('i.asin', 'ASC')
      .getMany();

    const asinSet = new Set(records.map(r => r.asin));
    const summary: InventorySnapshotSummary = {
      totalAsins:           asinSet.size,
      totalSellableUnits:   records.reduce((s, r) => s + (r.sellableOnHandInventoryUnits   || 0), 0),
      totalUnsellableUnits: records.reduce((s, r) => s + (r.unsellableOnHandInventoryUnits || 0), 0),
      avgOosRatePct: records.length > 0
        ? (records.reduce((s, r) => s + (r.sourceableProductOutOfStockRate || 0), 0) / records.length) * 100
        : 0,
      totalOpenPoUnits: records.reduce((s, r) => s + (r.openPurchaseOrderUnits || 0), 0),
    };

    return { period: { startDate, endDate }, records, summary, rowCount: records.length };
  }

  /**
   * Returns raw ASIN-level rows from the amazon_inventory_by_asin table
   * for the given date range.
   */
  async queryInventoryByAsin(
    startDate: string,
    endDate: string,
  ): Promise<AmazonInventoryByAsin[]> {
    return this.inventoryRepo
      .createQueryBuilder('i')
      .where('i.startDate >= :startDate', { startDate })
      .andWhere('i.endDate <= :endDate',   { endDate })
      .orderBy('i.startDate', 'ASC')
      .addOrderBy('i.asin', 'ASC')
      .getMany();
  }
}
