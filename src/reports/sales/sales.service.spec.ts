import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';
import { AmazonSalesAggregate } from './entities/amazon-sales-aggregate.entity';
import { AmazonSalesByAsin } from './entities/amazon-sales-by-asin.entity';
import { SalesService } from './sales.service';

describe('SalesService', () => {
  let service: SalesService;
  let salesAggregateRepo: { create: jest.Mock; createQueryBuilder: jest.Mock };
  let amazonApiService: {
    normalizeDate: jest.Mock;
    getReportDocument: jest.Mock;
    downloadAndParseReport: jest.Mock;
  };

  const makeQueryBuilder = (rows: AmazonSalesAggregate[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  const aggregateRow = (
    startDate: string,
    endDate: string,
    values: Partial<AmazonSalesAggregate>,
  ): AmazonSalesAggregate => ({
    startDate,
    endDate,
    customerReturns: 0,
    orderedRevenueAmount: 0,
    orderedRevenueCurrency: 'USD',
    orderedUnits: 0,
    shippedCogsAmount: 0,
    shippedCogsCurrency: 'USD',
    shippedRevenueAmount: 0,
    shippedRevenueCurrency: 'USD',
    shippedUnits: 0,
    ...values,
  });

  beforeEach(async () => {
    const salesByAsinRepo = {
      create: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    salesAggregateRepo = {
      create: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    amazonApiService = {
      normalizeDate: jest.fn(),
      getReportDocument: jest.fn(),
      downloadAndParseReport: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: getRepositoryToken(AmazonSalesByAsin), useValue: salesByAsinRepo },
        { provide: getRepositoryToken(AmazonSalesAggregate), useValue: salesAggregateRepo },
        { provide: AmazonApiService, useValue: amazonApiService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<SalesService>(SalesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('excludes the weekly summary row from totals when daily rows are present', async () => {
    const rows = [
      aggregateRow('2026-05-10', '2026-05-16', {
        customerReturns: 3,
        shippedCogsAmount: 60,
        shippedRevenueAmount: 100,
        shippedUnits: 10,
      }),
      aggregateRow('2026-05-10', '2026-05-10', {
        customerReturns: 1,
        shippedCogsAmount: 24,
        shippedRevenueAmount: 40,
        shippedUnits: 4,
      }),
      aggregateRow('2026-05-11', '2026-05-11', {
        customerReturns: 2,
        shippedCogsAmount: 36,
        shippedRevenueAmount: 60,
        shippedUnits: 6,
      }),
    ];
    salesAggregateRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(rows));

    const result = await service.querySalesSummary('2026-05-10', '2026-05-16');

    expect(result.totals.shippedRevenue).toBe(100);
    expect(result.totals.shippedUnits).toBe(10);
    expect(result.totals.shippedCogs).toBe(60);
    expect(result.totals.customerReturns).toBe(3);
    expect(result.rowCount).toBe(3);
    expect(result.totalRowCount).toBe(2);
    expect(result.summaryRowCount).toBe(1);
    expect(result.summaryRows).toHaveLength(1);
  });

  it('uses Amazon FATAL error documents to build human-readable sync errors', async () => {
    amazonApiService.getReportDocument.mockResolvedValue({ url: 'https://example.test/error.json' });
    amazonApiService.downloadAndParseReport.mockResolvedValue({
      errors: [
        {
          code: 'InvalidInput',
          message: 'No data available for the selected date range.',
          details: 'Choose a completed Amazon Sunday-Saturday week.',
        },
      ],
    });

    const message = await (service as any).buildHumanReadableReportFailure(
      '397841020608',
      'FATAL',
      { reportDocumentId: 'fatal-doc-1' },
    );

    expect(message).toContain('Sales report 397841020608 failed at Amazon.');
    expect(message).toContain('Amazon says: InvalidInput: No data available for the selected date range. Choose a completed Amazon Sunday-Saturday week.');
  });
});
