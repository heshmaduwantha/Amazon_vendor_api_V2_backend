import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AmazonSalesByAsin } from './entities/amazon-sales-by-asin.entity';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectRepository(AmazonSalesByAsin)
    private readonly salesRepo: Repository<AmazonSalesByAsin>,
    private readonly amazonApiService: AmazonApiService,
  ) {}

  async syncDailySales(startDate: string, endDate: string) {
    const normalizedStartDate = this.amazonApiService.normalizeDate(startDate, 'start');
    const normalizedEndDate = this.amazonApiService.normalizeDate(endDate, 'end');

    this.logger.log(`Syncing daily sales from ${normalizedStartDate} to ${normalizedEndDate}`);

    const endpoint = '/vendor/sales/v1/report';
    const params = {
      reportType: 'GET_VENDOR_SALES_REPORT',
      dataStartTime: normalizedStartDate,
      dataEndTime: normalizedEndDate,
    };

    const records = await this.amazonApiService.fetchAllPages<any>(endpoint, params);
    this.logger.log(`Fetched ${records.length} records. Beginning Chunked Batch Upsert...`);

    const BATCH_SIZE = 500;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const entities = chunk.map(record => this.salesRepo.create({
        start_date: new Date(normalizedStartDate),
        end_date: new Date(normalizedEndDate),
        asin: record.asin,
        customer_returns: record.customerReturns || 0,
        shipped_cogs_amount: record.shippedCogs?.amount ?? record.shippedCogs ?? 0,
        shipped_cogs_currency: record.shippedCogs?.currencyCode ?? 'USD',
        shipped_revenue_amount: record.shippedRevenue?.amount ?? record.shippedRevenue ?? 0,
        shipped_revenue_currency: record.shippedRevenue?.currencyCode ?? 'USD',
        shipped_units: record.shippedUnits || 0,
        ordered_revenue_amount: record.orderedRevenue?.amount ?? record.orderedRevenue ?? 0,
        ordered_revenue_currency: record.orderedRevenue?.currencyCode ?? 'USD',
        ordered_units: record.orderedUnits || 0,
      }));

      await this.salesRepo
        .createQueryBuilder()
        .insert()
        .into(AmazonSalesByAsin)
        .values(entities)
        .orUpdate(
          [
            'customer_returns',
            'shipped_cogs_amount',
            'shipped_cogs_currency',
            'shipped_revenue_amount',
            'shipped_revenue_currency',
            'shipped_units',
            'ordered_revenue_amount',
            'ordered_revenue_currency',
            'ordered_units',
          ],
          ['start_date', 'end_date', 'asin']
        )
        .execute();
      
      this.logger.debug(`Processed batch of ${chunk.length} sales records.`);
    }

    this.logger.log(`Successfully synced and batch-upserted daily sales data.`);
  }
}
