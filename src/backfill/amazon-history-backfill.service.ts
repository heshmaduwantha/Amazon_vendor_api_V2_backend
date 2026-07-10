import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InventoryService } from '../reports/inventory/inventory.service';
import { maskSecret } from '../utils/mask-secret.util';
import {
  BackfillChunk,
  enumerateDates,
  generateBackwardChunks,
} from './backfill-date.util';
import {
  BackfillCheckpointStore,
  BackfillChunkCheckpoint,
} from './backfill-checkpoint.store';
import { BackfillOptions } from './backfill-options';

export interface BackfillRunSummary {
  totalChunks: number;
  successfulChunks: number;
  skippedCompletedChunks: number;
  failedChunks: number;
  totalFetched: number;
  totalTransformed: number;
  totalInserted: number;
  totalUpdated: number;
  totalSkipped: number;
  totalFailedRecords: number;
  duplicateBusinessKeys: number;
  zeroDataDates: string[];
  failedDateRanges: BackfillChunk[];
  runtimeSeconds: number;
}

@Injectable()
export class AmazonHistoryBackfillService {
  private readonly logger = new Logger(AmazonHistoryBackfillService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly inventoryService: InventoryService,
  ) {}

  async run(options: BackfillOptions): Promise<BackfillRunSummary> {
    const startedAt = Date.now();
    const allChunks = generateBackwardChunks(
      options.startDate,
      options.endDate,
      options.chunkDays,
    );
    const chunks = options.forceChunk ? [options.forceChunk] : allChunks;
    const checkpointStore = new BackfillCheckpointStore(options.checkpointPath);
    await checkpointStore.load();
    checkpointStore.initializeJob(
      options.jobId,
      options.startDate,
      options.endDate,
      options.chunkDays,
    );

    const summary: BackfillRunSummary = {
      totalChunks: chunks.length,
      successfulChunks: 0,
      skippedCompletedChunks: 0,
      failedChunks: 0,
      totalFetched: 0,
      totalTransformed: 0,
      totalInserted: 0,
      totalUpdated: 0,
      totalSkipped: 0,
      totalFailedRecords: 0,
      duplicateBusinessKeys: 0,
      zeroDataDates: [],
      failedDateRanges: [],
      runtimeSeconds: 0,
    };

    this.log('job_start', {
      jobId: options.jobId,
      startDate: options.startDate,
      endDate: options.endDate,
      chunkDays: options.chunkDays,
      direction: 'backward',
      dryRun: options.dryRun,
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
        this.log('chunk_skipped_completed', {
          ...chunk,
          chunkNumber: index + 1,
        });
        continue;
      }

      const chunkStartedAt = new Date();
      const checkpoint = this.emptyCheckpoint(chunk, chunkStartedAt);
      await checkpointStore.record(options.jobId, checkpoint);
      this.log('chunk_start', {
        ...chunk,
        chunkNumber: index + 1,
        totalChunks: chunks.length,
      });

      try {
        const rawRecords = await this.inventoryService.fetchInventoryChunk(
          chunk.startDate,
          chunk.endDate,
        );
        const prepared = this.inventoryService.prepareInventoryRecords(
          rawRecords,
          chunk.startDate,
          chunk.endDate,
        );
        checkpoint.fetchedCount = prepared.fetchedCount;
        checkpoint.transformedCount = prepared.transformedCount;
        checkpoint.failedCount = prepared.failedCount;
        checkpoint.duplicateBusinessKeyCount =
          prepared.duplicateBusinessKeyCount;
        checkpoint.zeroDataDates = this.findZeroDataDates(
          chunk,
          prepared.records,
        );

        if (prepared.failedCount > 0) {
          throw new Error(
            `${prepared.failedCount} record(s) failed required ID/date validation.`,
          );
        }

        const loadResult = options.dryRun
          ? await this.inventoryService.previewInventoryRecords(
              prepared.records,
            )
          : await this.dataSource.transaction((manager) =>
              this.inventoryService.loadInventoryRecords(
                prepared.records,
                manager,
              ),
            );

        const classifiedCount =
          loadResult.insertedCount +
          loadResult.updatedCount +
          loadResult.skippedCount;
        if (classifiedCount !== prepared.transformedCount) {
          throw new Error(
            `Load reconciliation mismatch: transformed=${prepared.transformedCount}, classified=${classifiedCount}.`,
          );
        }

        checkpoint.insertedCount = loadResult.insertedCount;
        checkpoint.updatedCount = loadResult.updatedCount;
        checkpoint.skippedCount = loadResult.skippedCount;
        checkpoint.status = options.dryRun ? 'dry_run' : 'success';
        checkpoint.executionEndedAt = new Date().toISOString();
        await checkpointStore.record(options.jobId, checkpoint);

        summary.successfulChunks++;
        summary.totalFetched += checkpoint.fetchedCount;
        summary.totalTransformed += checkpoint.transformedCount;
        summary.totalInserted += checkpoint.insertedCount;
        summary.totalUpdated += checkpoint.updatedCount;
        summary.totalSkipped += checkpoint.skippedCount;
        summary.duplicateBusinessKeys += checkpoint.duplicateBusinessKeyCount;
        summary.zeroDataDates.push(...checkpoint.zeroDataDates);

        this.log('chunk_finish', {
          ...chunk,
          status: checkpoint.status,
          fetched: checkpoint.fetchedCount,
          transformed: checkpoint.transformedCount,
          inserted: checkpoint.insertedCount,
          updated: checkpoint.updatedCount,
          skipped: checkpoint.skippedCount,
          duplicateBusinessKeys: checkpoint.duplicateBusinessKeyCount,
          zeroDataDates: checkpoint.zeroDataDates,
          durationSeconds: this.durationSeconds(chunkStartedAt),
        });
      } catch (error: unknown) {
        checkpoint.status = 'failed';
        checkpoint.failedCount = checkpoint.failedCount || 1;
        checkpoint.errorSummary = this.safeErrorSummary(error);
        checkpoint.executionEndedAt = new Date().toISOString();
        await checkpointStore.record(options.jobId, checkpoint);

        summary.failedChunks++;
        summary.totalFetched += checkpoint.fetchedCount;
        summary.totalTransformed += checkpoint.transformedCount;
        summary.totalFailedRecords += checkpoint.failedCount;
        summary.duplicateBusinessKeys += checkpoint.duplicateBusinessKeyCount;
        summary.failedDateRanges.push(chunk);
        this.logger.error(
          JSON.stringify({
            event: 'chunk_failed',
            ...chunk,
            error: checkpoint.errorSummary,
            durationSeconds: this.durationSeconds(chunkStartedAt),
          }),
        );
      }
    }

    summary.zeroDataDates = [...new Set(summary.zeroDataDates)].sort();
    summary.runtimeSeconds = Math.round((Date.now() - startedAt) / 100) / 10;

    const reconciliation = await this.inventoryService.getInventoryCountsByDate(
      options.startDate,
      options.endDate,
    );
    this.log('reconciliation_counts_by_date', { counts: reconciliation });
    this.log('job_finish', { ...summary });
    return summary;
  }

  private emptyCheckpoint(
    chunk: BackfillChunk,
    startedAt: Date,
  ): BackfillChunkCheckpoint {
    return {
      ...chunk,
      executionStartedAt: startedAt.toISOString(),
      executionEndedAt: null,
      fetchedCount: 0,
      transformedCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      duplicateBusinessKeyCount: 0,
      zeroDataDates: [],
      status: 'running',
      errorSummary: null,
    };
  }

  private findZeroDataDates(
    chunk: BackfillChunk,
    records: Array<{ startDate: string; endDate: string }>,
  ): string[] {
    const datesWithData = new Set<string>();
    for (const record of records) {
      for (const date of enumerateDates(record.startDate, record.endDate))
        datesWithData.add(date);
    }
    return enumerateDates(chunk.startDate, chunk.endDate).filter(
      (date) => !datesWithData.has(date),
    );
  }

  private safeErrorSummary(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return maskSecret(message || 'Unknown backfill error').slice(0, 1000);
  }

  private durationSeconds(startedAt: Date): number {
    return Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
  }

  private log(event: string, details: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ event, ...details }));
  }
}
