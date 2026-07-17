import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { SalesService } from '../reports/sales/sales.service';
import { AmazonSalesHistoryBackfillService } from './amazon-sales-history-backfill.service';
import { BackfillOptions } from './backfill-options';

describe('AmazonSalesHistoryBackfillService', () => {
  const checkpointPath = join(
    tmpdir(),
    `amazon-sales-backfill-test-${process.pid}.json`,
  );

  afterEach(async () => {
    await unlink(checkpointPath).catch(() => undefined);
  });

  function options(overrides: Partial<BackfillOptions> = {}): BackfillOptions {
    return {
      startDate: '2023-01-01',
      endDate: '2023-01-15',
      chunkDays: 7,
      existingDataStartDate: '2025-10-01',
      dryRun: false,
      confirmProd: true,
      nonInteractive: false,
      resume: false,
      overrideSafetyBoundary: false,
      checkpointPath,
      jobId: 'amazon-sales-test',
      ...overrides,
    };
  }

  it('processes backward sequential chunks and continues after a failure', async () => {
    const calls: string[] = [];
    const syncDailySales = jest.fn((startDate: string, endDate: string) => {
      calls.push(`${startDate}:${endDate}`);
      return startDate === '2023-01-02'
        ? Promise.reject(new Error('Amazon queue failed'))
        : Promise.resolve();
    });
    const query = jest.fn((sql: string) => {
      const byAsin = sql.includes('amazon_sales_by_asin');
      return Promise.resolve([
        {
          rowCount: byAsin ? '140' : '15',
          distinctStartDateCount: '15',
          minDate: '2023-01-01',
          maxDate: '2023-01-15',
          shippedUnitsSum: byAsin ? '456' : '456',
        },
      ]);
    });
    const service = new AmazonSalesHistoryBackfillService(
      { query } as unknown as DataSource,
      { syncDailySales } as unknown as SalesService,
    );

    const result = await service.run(options());

    expect(calls).toEqual([
      '2023-01-09:2023-01-15',
      '2023-01-02:2023-01-08',
      '2023-01-01:2023-01-01',
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        totalChunks: 3,
        successfulChunks: 2,
        failedChunks: 1,
        failedDateRanges: [
          {
            startDate: '2023-01-02',
            endDate: '2023-01-08',
            error: 'Amazon queue failed',
          },
        ],
      }),
    );
    expect(result.reconciliation.salesByAsin).toEqual({
      rowCount: 140,
      distinctStartDateCount: 15,
      minDate: '2023-01-01',
      maxDate: '2023-01-15',
      shippedUnitsSum: 456,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects dry-run before calling the sales sync', async () => {
    const syncDailySales = jest.fn();
    const service = new AmazonSalesHistoryBackfillService(
      { query: jest.fn() } as unknown as DataSource,
      { syncDailySales } as unknown as SalesService,
    );

    await expect(service.run(options({ dryRun: true }))).rejects.toThrow(
      'Sales backfill dry-run is not supported because SalesService.syncDailySales performs database upserts.',
    );
    expect(syncDailySales).not.toHaveBeenCalled();
  });

  it('skips successful checkpoint chunks when resuming', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        rowCount: '1',
        distinctStartDateCount: '1',
        minDate: '2023-01-01',
        maxDate: '2023-01-01',
        shippedUnitsSum: '2',
      },
    ]);
    const initialSync = jest.fn().mockResolvedValue(undefined);
    const initialService = new AmazonSalesHistoryBackfillService(
      { query } as unknown as DataSource,
      { syncDailySales: initialSync } as unknown as SalesService,
    );
    const singleDayOptions = options({
      endDate: '2023-01-01',
      jobId: 'amazon-sales-resume-test',
    });
    await initialService.run(singleDayOptions);

    const resumedSync = jest.fn();
    const resumedService = new AmazonSalesHistoryBackfillService(
      { query } as unknown as DataSource,
      { syncDailySales: resumedSync } as unknown as SalesService,
    );
    const result = await resumedService.run({
      ...singleDayOptions,
      resume: true,
    });

    expect(resumedSync).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        totalChunks: 1,
        successfulChunks: 0,
        skippedCompletedChunks: 1,
        failedChunks: 0,
      }),
    );
  });
});
