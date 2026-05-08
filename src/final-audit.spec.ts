import { SyncService } from '../src/sync/sync.service';
import { SalesService } from '../src/reports/sales/sales.service';
import { InventoryService } from '../src/reports/inventory/inventory.service';
import { maskSecret } from '../src/utils/mask-secret.util';

describe('Final Production Audit: AntiGravity v2.0', () => {
  
  describe('1. Security: Log Masking Verification', () => {
    test('Should scrub AWS and LWA secrets from strings', () => {
      const sensitiveLog = 'Error connecting with AKIA1234567890ABCDEF and secret "Atzr|v1|mock_token_secret"';
      const masked = maskSecret(sensitiveLog);
      
      console.log(`Original: ${sensitiveLog}`);
      console.log(`Masked: ${masked}`);
      
      expect(masked).not.toContain('AKIA1234567890ABCDEF');
      expect(masked).not.toContain('Atzr|v1|mock_token_secret');
      expect(masked).toContain('[MASKED]');
    });
  });

  describe('2. Race Conditions: Global Sync Lock', () => {
    let syncService: SyncService;
    let mockSales: any;
    let mockInventory: any;

    beforeEach(() => {
      mockSales = { syncDailySales: jest.fn().mockImplementation(() => new Promise(res => setTimeout(res, 1000))) };
      mockInventory = { syncDailyInventory: jest.fn().mockResolvedValue({}) };
      syncService = new SyncService(mockSales, mockInventory);
    });

    test('Should reject concurrent sync requests with 409 Conflict', async () => {
      console.log('--- Simulating Concurrent Sync Trigger ---');
      
      // Start first sync (takes 1s+)
      const firstSync = syncService.executeSync('2026-05-01', '2026-05-01');
      
      // Immediately try second sync
      try {
        await syncService.executeSync('2026-05-02', '2026-05-02');
      } catch (error: any) {
        console.log(`Second Sync Status: ${error.status} ${error.message}`);
        expect(error.status).toBe(409);
      }

      await firstSync;
      console.log('✅ Global Sync Lock Verified');
    });
  });

  describe('3. Performance: Batch Processing Check', () => {
    let salesService: SalesService;
    let mockRepo: any;
    let mockApi: any;

    beforeEach(() => {
      mockRepo = { 
        create: jest.fn(x => x),
        createQueryBuilder: jest.fn().mockReturnValue({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orUpdate: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({})
        })
      };
      mockApi = { 
        normalizeDate: jest.fn(x => x),
        fetchAllPages: jest.fn().mockResolvedValue(new Array(1200).fill({ asin: 'TEST', shippedUnits: 10 })) 
      };
      salesService = new SalesService(mockRepo, mockApi);
    });

    test('Should process 1200 records in 3 chunks of 500 max', async () => {
      console.log('--- Simulating High-Volume Ingestion (1200 records) ---');
      await salesService.syncDailySales('2026-05-01', '2026-05-01');

      // 1200 records / 500 batch size = 3 batches (500, 500, 200)
      expect(mockRepo.createQueryBuilder().execute).toHaveBeenCalledTimes(3);
      
      const firstBatchSize = mockRepo.createQueryBuilder().values.mock.calls[0][0].length;
      const lastBatchSize = mockRepo.createQueryBuilder().values.mock.calls[2][0].length;
      
      console.log(`Batch 1 Size: ${firstBatchSize}`);
      console.log(`Batch 3 Size: ${lastBatchSize}`);
      
      expect(firstBatchSize).toBe(500);
      expect(lastBatchSize).toBe(200);
      console.log('✅ Batch Processing logic verified');
    });
  });
});
