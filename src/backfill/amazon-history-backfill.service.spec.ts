import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataSource } from 'typeorm';
import { InventoryService } from '../reports/inventory/inventory.service';
import { AmazonHistoryBackfillService } from './amazon-history-backfill.service';
import { BackfillOptions } from './backfill-options';

describe('AmazonHistoryBackfillService', () => {
  const checkpointPath = join(
    tmpdir(),
    `amazon-backfill-test-${process.pid}.json`,
  );

  afterEach(async () => {
    await unlink(checkpointPath).catch(() => undefined);
  });

  it('fetches and transforms in dry-run mode without starting a transaction', async () => {
    const transaction = jest.fn();
    const fetchInventoryChunk = jest.fn().mockResolvedValue([
      {
        startDate: '2025-09-30',
        endDate: '2025-09-30',
        asin: 'B000TEST01',
      },
    ]);
    const previewInventoryRecords = jest.fn().mockResolvedValue({
      insertedCount: 1,
      updatedCount: 0,
      skippedCount: 0,
    });
    const dataSource = { transaction } as unknown as DataSource;
    const inventoryService = {
      fetchInventoryChunk,
      prepareInventoryRecords: jest.fn().mockReturnValue({
        records: [
          {
            startDate: '2025-09-30',
            endDate: '2025-09-30',
            asin: 'B000TEST01',
          },
        ],
        fetchedCount: 1,
        transformedCount: 1,
        duplicateBusinessKeyCount: 0,
        failedCount: 0,
      }),
      previewInventoryRecords,
      getInventoryCountsByDate: jest.fn().mockResolvedValue([]),
    } as unknown as InventoryService;
    const service = new AmazonHistoryBackfillService(
      dataSource,
      inventoryService,
    );
    const options: BackfillOptions = {
      startDate: '2025-09-30',
      endDate: '2025-09-30',
      chunkDays: 15,
      existingDataStartDate: '2025-10-01',
      dryRun: true,
      confirmProd: false,
      nonInteractive: false,
      resume: false,
      overrideSafetyBoundary: false,
      checkpointPath,
      jobId: 'dry-run-test',
    };

    const summary = await service.run(options);

    expect(fetchInventoryChunk).toHaveBeenCalledWith(
      '2025-09-30',
      '2025-09-30',
    );
    expect(previewInventoryRecords).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
    expect(summary).toEqual(
      expect.objectContaining({ successfulChunks: 1, totalInserted: 1 }),
    );
  });
});
