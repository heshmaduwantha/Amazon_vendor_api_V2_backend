import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AmazonSalesByAsin } from './entities/amazon-sales-by-asin.entity';
import { AmazonSalesAggregate } from './entities/amazon-sales-aggregate.entity';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';

// ─── Query result shapes ──────────────────────────────────────────────────────

export interface SalesTotals {
  orderedUnits:    number;
  orderedRevenue:  number;
  shippedUnits:    number;
  shippedRevenue:  number;
  shippedCogs:     number;
  customerReturns: number;
  currency:        string;
}

export interface SalesSummaryResult {
  period:          { startDate: string; endDate: string };
  dailyAggregates: AmazonSalesAggregate[];
  totals:          SalesTotals;
  rowCount:        number;
}

/**
 * Vendor Sales Report Options — built from env vars so they can be tuned
 * without a code change.
 *
 * VENDOR_DISTRIBUTOR_VIEW  = SOURCING | MANUFACTURING   (default: SOURCING)
 * VENDOR_SELLING_PROGRAM   = RETAIL | FRESH             (default: RETAIL)
 * VENDOR_REPORT_PERIOD     = DAY | WEEK | MONTH         (default: DAY)
 *
 * If your account is a Manufacturing vendor, set VENDOR_DISTRIBUTOR_VIEW=MANUFACTURING
 */
function buildSalesReportOptions(configService: import('@nestjs/config').ConfigService) {
  return {
    reportPeriod:    configService.get<string>('VENDOR_REPORT_PERIOD')     || 'DAY',
    distributorView: configService.get<string>('VENDOR_DISTRIBUTOR_VIEW')  || 'SOURCING',
    sellingProgram:  configService.get<string>('VENDOR_SELLING_PROGRAM')   || 'RETAIL',
  };
}

const BATCH_SIZE = 500;

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectRepository(AmazonSalesByAsin)
    private readonly salesByAsinRepo: Repository<AmazonSalesByAsin>,
    @InjectRepository(AmazonSalesAggregate)
    private readonly salesAggregateRepo: Repository<AmazonSalesAggregate>,
    private readonly amazonApiService: AmazonApiService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Sales sync flow (Phase 3 — matches legacy approach):
   *
   * PRIMARY  — List Amazon's pre-generated DONE reports for the date range
   *            and process each one.  Amazon auto-generates vendor reports on
   *            a schedule; this mirrors exactly what the legacy code did.
   *
   * FALLBACK — If Amazon has no pre-generated reports for the range (e.g. a
   *            historical back-fill), attempt on-demand report creation.
   */
  async syncDailySales(
    startDate: string,
    endDate: string,
    onStageChange?: (stage: any) => Promise<void>,
  ): Promise<void> {
    const normalizedStartDate = this.amazonApiService.normalizeDate(startDate, 'start');
    const normalizedEndDate   = this.amazonApiService.normalizeDate(endDate,   'end');
    const marketplaceId = this.configService.get<string>('MARKETPLACE_ID') || 'ATVPDKIKX0DER';
    const reportType    = 'GET_VENDOR_SALES_REPORT';

    this.logger.log(`[Sales] Syncing ${normalizedStartDate} → ${normalizedEndDate}`);

    // ── Step 1: look for reports Amazon has already generated ─────────────────
    if (onStageChange) await onStageChange('REQUESTING_REPORT');

    const existingReports = await this.amazonApiService.listExistingReports(
      reportType, marketplaceId, normalizedStartDate, normalizedEndDate,
    );

    let documentIds: string[] = existingReports
      .map((r: any) => r.reportDocumentId)
      .filter(Boolean)
      .slice(0, 3); // 3 most-recent only — each getReportDocument = 1 quota slot; burst limit = 15

    if (documentIds.length > 0) {
      this.logger.log(`[Sales] Found ${existingReports.length} pre-generated report(s) — processing ${documentIds.length} most recent.`);
    } else {
      // ── Fallback: create a new on-demand report ─────────────────────────────
      this.logger.warn(`[Sales] No pre-generated reports found. Attempting on-demand creation...`);
      const reportOptions = buildSalesReportOptions(this.configService);
      this.logger.log(`[Sales] reportOptions: ${JSON.stringify(reportOptions)}`);

      const { reportId } = await this.amazonApiService.createReport(
        reportType, [marketplaceId],
        normalizedStartDate, normalizedEndDate,
        reportOptions,
      );
      this.logger.log(`[Sales] Report created. reportId: ${reportId}`);

      const docId = await this.pollUntilDone(reportId, onStageChange);
      this.logger.log(`[Sales] Report DONE. documentId: ${docId}`);
      documentIds = [docId];
    }

    // ── Step 2: download + upsert each document ───────────────────────────────
    let totalByAsin = 0;
    let totalAggregate = 0;

    for (const docId of documentIds) {
      if (onStageChange) await onStageChange('FETCHING_DOCUMENT');
      const doc = await this.amazonApiService.getReportDocument(docId);

      if (onStageChange) await onStageChange('DOWNLOADING_REPORT');
      const rawContent = await this.amazonApiService.downloadAndParseReport(
        doc.url, doc.compressionAlgorithm,
      );

      if (onStageChange) await onStageChange('PARSING_REPORT');

      const salesByAsin: any[]    = rawContent?.salesByAsin    ?? [];
      const salesAggregate: any[] = rawContent?.salesAggregate ?? [];
      totalByAsin    += salesByAsin.length;
      totalAggregate += salesAggregate.length;

      if (onStageChange) await onStageChange('UPSERTING_DATABASE');
      await this.upsertSalesByAsin(salesByAsin);
      await this.upsertSalesAggregate(salesAggregate);

      this.logger.log(`[Sales] Document ${docId} — byAsin: ${salesByAsin.length}, aggregate: ${salesAggregate.length}`);
    }

    this.logger.log(`[Sales] Sync complete. Total rows — byAsin: ${totalByAsin}, aggregate: ${totalAggregate}`);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private async pollUntilDone(
    reportId: string,
    onStageChange?: (stage: any) => Promise<void>,
    maxAttempts = 30,
    intervalMs = 10000,
  ): Promise<string> {
    let lastReportStatus = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

      this.logger.debug(`[Sales] Poll ${attempt}/${maxAttempts} — reportId: ${reportId}, processingStatus: ${processingStatus}`);

      if (processingStatus === 'DONE') {
        return report.reportDocumentId;
      }

      if (['CANCELLED', 'FATAL'].includes(processingStatus)) {
        this.logger.error(
          `[Sales] Report ${processingStatus} — Amazon response:\n${JSON.stringify(report, null, 2)}`,
        );

        // Amazon often attaches an error document to FATAL reports — download it
        // to get the human-readable reason (e.g. "No data available", "Invalid reportOptions")
        if (report.reportDocumentId) {
          try {
            this.logger.log(`[Sales] Downloading FATAL error document: ${report.reportDocumentId}`);
            const errDoc  = await this.amazonApiService.getReportDocument(report.reportDocumentId);
            const errBody = await this.amazonApiService.downloadAndParseReport(errDoc.url, errDoc.compressionAlgorithm);
            this.logger.error(`[Sales] FATAL error document contents:\n${JSON.stringify(errBody, null, 2)}`);
          } catch (docErr: any) {
            this.logger.warn(`[Sales] Could not fetch error document: ${docErr.message}`);
          }
        }

        throw new Error(`[Sales] Report ${reportId} status: ${processingStatus}. See logs for Amazon's error document.`);
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`[Sales] Report ${reportId} did not complete within ${maxAttempts * intervalMs / 1000}s`);
  }

  private async upsertSalesByAsin(records: any[]): Promise<void> {
    if (!records.length) {
      this.logger.debug(`[Sales] No salesByAsin records to upsert.`);
      return;
    }

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const entities = chunk.map(r => this.salesByAsinRepo.create({
        startDate: r.startDate,
        endDate: r.endDate,
        asin: r.asin,
        customerReturns: r.customerReturns ?? 0,
        shippedCogsAmount: r.shippedCogs?.amount ?? 0,
        shippedCogsCurrency: r.shippedCogs?.currencyCode ?? 'USD',
        shippedRevenueAmount: r.shippedRevenue?.amount ?? 0,
        shippedRevenueCurrency: r.shippedRevenue?.currencyCode ?? 'USD',
        shippedUnits: r.shippedUnits ?? 0,
        orderedRevenueAmount: r.orderedRevenue?.amount ?? 0,
        orderedRevenueCurrency: r.orderedRevenue?.currencyCode ?? 'USD',
        orderedUnits: r.orderedUnits ?? 0,
      }));

      await this.salesByAsinRepo
        .createQueryBuilder()
        .insert()
        .into(AmazonSalesByAsin)
        .values(entities)
        .orUpdate(
          ['customer_returns', 'shipped_cogs_amount', 'shipped_cogs_currency',
           'shipped_revenue_amount', 'shipped_revenue_currency', 'shipped_units',
           'ordered_revenue_amount', 'ordered_revenue_currency', 'ordered_units'],
          ['start_date', 'end_date', 'asin'],
        )
        .execute();

      this.logger.debug(`[Sales] salesByAsin batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} rows upserted.`);
    }
  }

  private async upsertSalesAggregate(records: any[]): Promise<void> {
    if (!records.length) {
      this.logger.debug(`[Sales] No salesAggregate records to upsert.`);
      return;
    }

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const entities = chunk.map(r => this.salesAggregateRepo.create({
        startDate: r.startDate,
        endDate: r.endDate,
        customerReturns: r.customerReturns ?? 0,
        orderedRevenueAmount: r.orderedRevenue?.amount ?? 0,
        orderedRevenueCurrency: r.orderedRevenue?.currencyCode ?? 'USD',
        orderedUnits: r.orderedUnits ?? 0,
        shippedCogsAmount: r.shippedCogs?.amount ?? 0,
        shippedCogsCurrency: r.shippedCogs?.currencyCode ?? 'USD',
        shippedRevenueAmount: r.shippedRevenue?.amount ?? 0,
        shippedRevenueCurrency: r.shippedRevenue?.currencyCode ?? 'USD',
        shippedUnits: r.shippedUnits ?? 0,
      }));

      await this.salesAggregateRepo
        .createQueryBuilder()
        .insert()
        .into(AmazonSalesAggregate)
        .values(entities)
        .orUpdate(
          ['customer_returns', 'ordered_revenue_amount', 'ordered_revenue_currency',
           'ordered_units', 'shipped_cogs_amount', 'shipped_cogs_currency',
           'shipped_revenue_amount', 'shipped_revenue_currency', 'shipped_units'],
          ['start_date', 'end_date'],
        )
        .execute();

      this.logger.debug(`[Sales] salesAggregate batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} rows upserted.`);
    }
  }

  // ── Phase 3: Data Tally Query ─────────────────────────────────────────────

  /**
   * Returns daily aggregate rows for the period plus summed totals.
   * Used by the Data Tally panel to compare against Vendor Central.
   */
  async querySalesSummary(
    startDate: string,
    endDate: string,
  ): Promise<SalesSummaryResult> {
    const aggregates = await this.salesAggregateRepo
      .createQueryBuilder('s')
      .where('s.startDate >= :startDate', { startDate })
      .andWhere('s.endDate <= :endDate',   { endDate })
      .orderBy('s.startDate', 'ASC')
      .getMany();

    const currency = aggregates[0]?.orderedRevenueCurrency ?? 'USD';

    const totals: SalesTotals = aggregates.reduce(
      (acc, row) => ({
        orderedUnits:    acc.orderedUnits    + (row.orderedUnits           || 0),
        orderedRevenue:  acc.orderedRevenue  + Number(row.orderedRevenueAmount  || 0),
        shippedUnits:    acc.shippedUnits    + (row.shippedUnits           || 0),
        shippedRevenue:  acc.shippedRevenue  + Number(row.shippedRevenueAmount  || 0),
        shippedCogs:     acc.shippedCogs     + Number(row.shippedCogsAmount     || 0),
        customerReturns: acc.customerReturns + (row.customerReturns        || 0),
        currency,
      }),
      { orderedUnits: 0, orderedRevenue: 0, shippedUnits: 0, shippedRevenue: 0, shippedCogs: 0, customerReturns: 0, currency },
    );

    return { period: { startDate, endDate }, dailyAggregates: aggregates, totals, rowCount: aggregates.length };
  }

  /**
   * Returns raw ASIN-level rows from the amazon_sales_by_asin table
   * for the given date range.
   */
  async querySalesByAsin(
    startDate: string,
    endDate: string,
  ): Promise<AmazonSalesByAsin[]> {
    return this.salesByAsinRepo
      .createQueryBuilder('s')
      .where('s.startDate >= :startDate', { startDate })
      .andWhere('s.endDate <= :endDate',   { endDate })
      .orderBy('s.startDate', 'ASC')
      .addOrderBy('s.asin', 'ASC')
      .getMany();
  }
}
