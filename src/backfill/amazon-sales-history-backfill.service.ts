import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SalesService } from '../reports/sales/sales.service';
import { maskSecret } from '../utils/mask-secret.util';
import { BackfillChunk, generateBackwardChunks } from './backfill-date.util';
import {
  BackfillCheckpointStore,
  BaseBackfillChunkCheckpoint,
} from './backfill-checkpoint.store';
import { BackfillOptions } from './backfill-options';

export type SalesBackfillChunk = BackfillChunk;

export interface SalesFailedDateRange extends SalesBackfillChunk {
  error: string;
}

export interface SalesTableReconciliation {
  rowCount: number;
  distinctStartDateCount: number;
  minDate: string | null;
  maxDate: string | null;
  shippedUnitsSum: number;
}

export interface SalesReconciliationResult {
  salesByAsin: SalesTableReconciliation;
  salesAggregate: SalesTableReconciliation;
}

export interface SalesBackfillRunSummary {
  totalChunks: number;
  successfulChunks: number;
  skippedCompletedChunks: number;
  failedChunks: number;
  failedDateRanges: SalesFailedDateRange[];
  runtimeSeconds: number;
  reconciliation: SalesReconciliationResult;
}

type SalesChunkCheckpoint = BaseBackfillChunkCheckpoint;

interface RawSalesReconciliation {
  rowCount: string;
  distinctStartDateCount: string;
  minDate: string | null;
  maxDate: string | null;
  shippedUnitsSum: string;
}

type SalesTableName =
  | 'public.amazon_sales_by_asin'
  | 'public.amazon_sales_aggregate';

@Injectable()
export class AmazonSalesHistoryBackfillService {
  private readonly logger = new Logger(AmazonSalesHistoryBackfillService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly salesService: SalesService,
  ) {}

  async run(options: BackfillOptions): Promise<SalesBackfillRunSummary> {
    if (options.dryRun) {
      throw new Error(
        'Sales backfill dry-run is not supported because SalesService.syncDailySales performs database upserts.',
      );
    }

    const startedAt = Date.now();
    const allChunks = generateBackwardChunks(
      options.startDate,
      options.endDate,
      options.chunkDays,
    );
    const chunks: SalesBackfillChunk[] = options.forceChunk
      ? [options.forceChunk]
      : allChunks;
    const checkpointStore = new BackfillCheckpointStore<SalesChunkCheckpoint>(
      options.checkpointPath,
    );
    await checkpointStore.load();
    checkpointStore.initializeJob(
      options.jobId,
      options.startDate,
      options.endDate,
      options.chunkDays,
    );

    const summary = this.emptySummary(chunks.length);
    this.log('sales_job_start', {
      jobId: options.jobId,
      startDate: options.startDate,
      endDate: options.endDate,
      chunkDays: options.chunkDays,
      direction: 'backward',
      checkpointPath: options.checkpointPath,
    });

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (
        options.resume &&
        !options.forceChunk &&
        checkpointStore.isSuccessful(options.jobId, chunk)
      ) {
        summary.skippedCompletedChunks++;
        this.log('sales_chunk_finish', {
          ...chunk,
          chunkNumber: index + 1,
          totalChunks: chunks.length,
          status: 'skipped_completed',
          durationSeconds: 0,
        });
        continue;
      }

      const chunkStartedAt = new Date();
      const checkpoint: SalesChunkCheckpoint = {
        ...chunk,
        executionStartedAt: chunkStartedAt.toISOString(),
        executionEndedAt: null,
        status: 'running',
        errorSummary: null,
      };
      await checkpointStore.record(options.jobId, checkpoint);
      this.log('sales_chunk_start', {
        ...chunk,
        chunkNumber: index + 1,
        totalChunks: chunks.length,
      });

      try {
        await this.salesService.syncDailySales(chunk.startDate, chunk.endDate);
        checkpoint.status = 'success';
        checkpoint.executionEndedAt = new Date().toISOString();
        await checkpointStore.record(options.jobId, checkpoint);
        summary.successfulChunks++;
        this.log('sales_chunk_finish', {
          ...chunk,
          chunkNumber: index + 1,
          totalChunks: chunks.length,
          status: 'success',
          durationSeconds: this.durationSeconds(chunkStartedAt),
        });
      } catch (error: unknown) {
        const errorMessage = this.normalizeError(error);
        checkpoint.status = 'failed';
        checkpoint.errorSummary = errorMessage;
        checkpoint.executionEndedAt = new Date().toISOString();
        await checkpointStore.record(options.jobId, checkpoint);
        summary.failedChunks++;
        summary.failedDateRanges.push({ ...chunk, error: errorMessage });
        this.logger.error(
          JSON.stringify({
            event: 'sales_chunk_failed',
            ...chunk,
            chunkNumber: index + 1,
            totalChunks: chunks.length,
            error: errorMessage,
            durationSeconds: this.durationSeconds(chunkStartedAt),
          }),
        );
      }
    }

    summary.reconciliation = await this.reconcile(
      options.startDate,
      options.endDate,
    );
    summary.runtimeSeconds = this.durationSeconds(new Date(startedAt));
    this.log('sales_reconciliation', summary.reconciliation);
    this.log('sales_job_finish', summary);
    return summary;
  }

  private emptySummary(totalChunks: number): SalesBackfillRunSummary {
    const emptyTable: SalesTableReconciliation = {
      rowCount: 0,
      distinctStartDateCount: 0,
      minDate: null,
      maxDate: null,
      shippedUnitsSum: 0,
    };
    return {
      totalChunks,
      successfulChunks: 0,
      skippedCompletedChunks: 0,
      failedChunks: 0,
      failedDateRanges: [],
      runtimeSeconds: 0,
      reconciliation: {
        salesByAsin: { ...emptyTable },
        salesAggregate: { ...emptyTable },
      },
    };
  }

  private async reconcile(
    startDate: string,
    endDate: string,
  ): Promise<SalesReconciliationResult> {
    const [salesByAsin, salesAggregate] = await Promise.all([
      this.reconcileTable('public.amazon_sales_by_asin', startDate, endDate),
      this.reconcileTable('public.amazon_sales_aggregate', startDate, endDate),
    ]);
    return { salesByAsin, salesAggregate };
  }

  private async reconcileTable(
    tableName: SalesTableName,
    startDate: string,
    endDate: string,
  ): Promise<SalesTableReconciliation> {
    const rows = await this.dataSource.query<RawSalesReconciliation[]>(
      `SELECT
         COUNT(*)::text AS "rowCount",
         COUNT(DISTINCT start_date::date)::text AS "distinctStartDateCount",
         MIN(start_date::date)::text AS "minDate",
         MAX(start_date::date)::text AS "maxDate",
         COALESCE(SUM(shipped_units), 0)::text AS "shippedUnitsSum"
       FROM ${tableName}
       WHERE start_date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate],
    );
    const row = rows[0];
    if (!row)
      throw new Error(`Reconciliation returned no row for ${tableName}.`);
    return {
      rowCount: Number(row.rowCount),
      distinctStartDateCount: Number(row.distinctStartDateCount),
      minDate: row.minDate,
      maxDate: row.maxDate,
      shippedUnitsSum: Number(row.shippedUnitsSum),
    };
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return maskSecret(message || 'Unknown sales backfill error').slice(0, 1000);
  }

  private durationSeconds(startedAt: Date): number {
    return Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
  }

  private log(event: string, details: object): void {
    this.logger.log(JSON.stringify({ event, ...details }));
  }
}
