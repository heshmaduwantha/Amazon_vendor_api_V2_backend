import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';
import { AmazonInventoryByAsin } from './entities/amazon-inventory-by-asin.entity';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  let service: InventoryService;
  let repository: {
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
  };
  let queryBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(async () => {
    queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    repository = {
      create: jest.fn((entity) => entity),
      createQueryBuilder: jest.fn(() => queryBuilder),
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        {
          provide: getRepositoryToken(AmazonInventoryByAsin),
          useValue: repository,
        },
        { provide: AmazonApiService, useValue: { normalizeDate: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('upserts inventory by ASIN using the record period and composite conflict key', async () => {
    const prepared = service.prepareInventoryRecords(
      [
        {
          startDate: '2026-04-05',
          endDate: '2026-04-05',
          asin: 'B000TEST01',
          sellableOnHandInventoryUnits: 12,
          unsellableOnHandInventoryUnits: 1,
          sellableOnHandInventoryCost: { amount: 24.5, currencyCode: 'USD' },
        },
        {
          asin: 'B000TEST02',
          openPurchaseOrderUnits: 7,
        },
      ],
      '2026-04-01',
      '2026-04-30',
    );
    const result = await service.loadInventoryRecords(prepared.records);

    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(queryBuilder.values).toHaveBeenCalledWith([
      expect.objectContaining({
        startDate: '2026-04-05',
        endDate: '2026-04-05',
        asin: 'B000TEST01',
        sellableOnHandInventoryUnits: 12,
        unsellableOnHandInventoryUnits: 1,
        sellableOnHandInventoryCostAmount: 24.5,
        sellableOnHandInventoryCostCurrencyCode: 'USD',
      }),
      expect.objectContaining({
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        asin: 'B000TEST02',
        openPurchaseOrderUnits: 7,
      }),
    ]);
    expect(queryBuilder.orUpdate).toHaveBeenCalledWith(
      expect.arrayContaining([
        'sellable_on_hand_inventory_units',
        'unsellable_on_hand_inventory_units',
        'open_purchase_order_units',
      ]),
      ['start_date', 'end_date', 'asin'],
    );
    expect(queryBuilder.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      insertedCount: 2,
      updatedCount: 0,
      skippedCount: 0,
    });
  });

  it('does not insert duplicates when the same business keys are loaded again', async () => {
    const prepared = service.prepareInventoryRecords(
      [
        {
          startDate: '2025-09-30',
          endDate: '2025-09-30',
          asin: 'B000TEST01',
          openPurchaseOrderUnits: 5,
        },
      ],
      '2025-09-30',
      '2025-09-30',
    );
    repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce(prepared.records);

    const first = await service.loadInventoryRecords(prepared.records);
    const second = await service.loadInventoryRecords(prepared.records);

    expect(first.insertedCount).toBe(1);
    expect(second).toEqual({
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: 1,
    });
    expect(queryBuilder.execute).toHaveBeenCalledTimes(1);
  });

  it('formats reconciliation dates without timezone conversion', async () => {
    const reconciliationBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { date: '2025-09-16', recordCount: '632' },
      ]),
    };
    repository.createQueryBuilder.mockReturnValueOnce(reconciliationBuilder);

    await expect(
      service.getInventoryCountsByDate('2025-09-16', '2025-09-30'),
    ).resolves.toEqual([{ date: '2025-09-16', recordCount: 632 }]);
    expect(reconciliationBuilder.select).toHaveBeenCalledWith(
      "TO_CHAR(inventory.startDate, 'YYYY-MM-DD')",
      'date',
    );
  });

  it('splits DAY inventory report ranges into Amazon-safe 15-day chunks', () => {
    expect((service as any).getInventoryReportRanges('2026-04-01', '2026-04-30', 'DAY')).toEqual([
      { startDate: '2026-04-01', endDate: '2026-04-15' },
      { startDate: '2026-04-16', endDate: '2026-04-30' },
    ]);

    expect((service as any).getInventoryReportRanges('2026-05-01', '2026-05-31', 'DAY')).toEqual([
      { startDate: '2026-05-01', endDate: '2026-05-15' },
      { startDate: '2026-05-16', endDate: '2026-05-30' },
      { startDate: '2026-05-31', endDate: '2026-05-31' },
    ]);

    expect((service as any).getInventoryReportRanges('2026-04-01', '2026-04-30', 'WEEK')).toEqual([
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    ]);

    expect(
      (service as any).getInventoryReportRanges('2026-04-01T00:00:00.000Z', '2026-04-30T23:59:59.999Z', 'DAY'),
    ).toEqual([
      { startDate: '2026-04-01', endDate: '2026-04-15' },
      { startDate: '2026-04-16', endDate: '2026-04-30' },
    ]);
  });
});
