import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AmazonInventoryByAsin } from './entities/amazon-inventory-by-asin.entity';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(AmazonInventoryByAsin)
    private readonly inventoryRepo: Repository<AmazonInventoryByAsin>,
    private readonly amazonApiService: AmazonApiService,
  ) {}

  async syncDailyInventory(startDate: string, endDate: string) {
    const normalizedStartDate = this.amazonApiService.normalizeDate(startDate, 'start');
    const normalizedEndDate = this.amazonApiService.normalizeDate(endDate, 'end');

    this.logger.log(`Syncing daily inventory from ${normalizedStartDate} to ${normalizedEndDate}`);

    const endpoint = '/vendor/inventory/v1/report';
    const params = {
      reportType: 'GET_VENDOR_INVENTORY_REPORT',
      dataStartTime: normalizedStartDate,
      dataEndTime: normalizedEndDate,
    };

    const records = await this.amazonApiService.fetchAllPages<any>(endpoint, params);
    this.logger.log(`Fetched ${records.length} records. Beginning Chunked Batch Upsert...`);

    const BATCH_SIZE = 500;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const entities = chunk.map(record => this.inventoryRepo.create({
        start_date: new Date(normalizedStartDate),
        end_date: new Date(normalizedEndDate),
        asin: record.asin,
        sourceable_product_out_of_stock_rate: record.sourceableProductOutOfStockRate ?? null,
        procurable_product_out_of_stock_rate: record.procurableProductOutOfStockRate ?? null,
        open_purchase_order_units: record.openPurchaseOrderUnits ?? null,
        receive_fill_rate: record.receiveFillRate ?? null,
        average_vendor_lead_time_days: record.averageVendorLeadTimeDays ?? null,
        sell_through_rate: record.sellThroughRate ?? null,
        unfilled_customer_ordered_units: record.unfilledCustomerOrderedUnits ?? null,
        vendor_confirmation_rate: record.vendorConfirmationRate ?? null,
        net_received_inventory_cost_amount: record.netReceivedInventoryCost?.amount ?? record.netReceivedInventoryCost ?? null,
        net_received_inventory_cost_currency_code: record.netReceivedInventoryCost?.currencyCode ?? null,
        net_received_inventory_units: record.netReceivedInventoryUnits ?? null,
        sellable_on_hand_inventory_cost_amount: record.sellableOnHandInventoryCost?.amount ?? record.sellableOnHandInventoryCost ?? null,
        sellable_on_hand_inventory_cost_currency_code: record.sellableOnHandInventoryCost?.currencyCode ?? null,
        sellable_on_hand_inventory_units: record.sellableOnHandInventoryUnits ?? null,
        unsellable_on_hand_inventory_cost_amount: record.unsellableOnHandInventoryCost?.amount ?? record.unsellableOnHandInventoryCost ?? null,
        unsellable_on_hand_inventory_cost_currency_code: record.unsellableOnHandInventoryCost?.currencyCode ?? null,
        unsellable_on_hand_inventory_units: record.unsellableOnHandInventoryUnits ?? null,
        aged_90_plus_days_sellable_inventory_cost_amount: record.aged90PlusDaysSellableInventoryCost?.amount ?? record.aged90PlusDaysSellableInventoryCost ?? null,
        aged_90_plus_days_sellable_inventory_cost_currency_code: record.aged90PlusDaysSellableInventoryCost?.currencyCode ?? null,
        aged_90_plus_days_sellable_inventory_units: record.aged90PlusDaysSellableInventoryUnits ?? null,
        reportId: record.reportId ?? null,
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
            'reportId',
          ],
          ['start_date', 'end_date', 'asin']
        )
        .execute();
      
      this.logger.debug(`Processed batch of ${chunk.length} inventory records.`);
    }

    this.logger.log(`Successfully synced and batch-upserted daily inventory data.`);
  }
}
