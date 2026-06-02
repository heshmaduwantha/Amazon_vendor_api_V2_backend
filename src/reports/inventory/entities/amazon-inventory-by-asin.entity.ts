import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('amazon_inventory_by_asin')
export class AmazonInventoryByAsin {
  @PrimaryColumn({ type: 'date', name: 'start_date' })
  startDate: string;

  @PrimaryColumn({ type: 'date', name: 'end_date' })
  endDate: string;

  @PrimaryColumn({ type: 'varchar' })
  asin: string;

  @Column({ type: 'float', name: 'sourceable_product_out_of_stock_rate', nullable: true })
  sourceableProductOutOfStockRate: number;

  @Column({ type: 'float', name: 'procurable_product_out_of_stock_rate', nullable: true })
  procurableProductOutOfStockRate: number;

  @Column({ type: 'int', name: 'open_purchase_order_units', nullable: true })
  openPurchaseOrderUnits: number;

  @Column({ type: 'float', name: 'receive_fill_rate', nullable: true })
  receiveFillRate: number;

  @Column({ type: 'float', name: 'average_vendor_lead_time_days', nullable: true })
  averageVendorLeadTimeDays: number;

  @Column({ type: 'float', name: 'sell_through_rate', nullable: true })
  sellThroughRate: number;

  @Column({ type: 'int', name: 'unfilled_customer_ordered_units', nullable: true })
  unfilledCustomerOrderedUnits: number;

  @Column({ type: 'float', name: 'vendor_confirmation_rate', nullable: true })
  vendorConfirmationRate: number;

  @Column({ type: 'float', name: 'net_received_inventory_cost_amount', nullable: true })
  netReceivedInventoryCostAmount: number;

  @Column({ type: 'varchar', name: 'net_received_inventory_cost_currency_code', nullable: true })
  netReceivedInventoryCostCurrencyCode: string;

  @Column({ type: 'int', name: 'net_received_inventory_units', nullable: true })
  netReceivedInventoryUnits: number;

  @Column({ type: 'float', name: 'sellable_on_hand_inventory_cost_amount', nullable: true })
  sellableOnHandInventoryCostAmount: number;

  @Column({ type: 'varchar', name: 'sellable_on_hand_inventory_cost_currency_code', nullable: true })
  sellableOnHandInventoryCostCurrencyCode: string;

  @Column({ type: 'int', name: 'sellable_on_hand_inventory_units', nullable: true })
  sellableOnHandInventoryUnits: number;

  @Column({ type: 'float', name: 'unsellable_on_hand_inventory_cost_amount', nullable: true })
  unsellableOnHandInventoryCostAmount: number;

  @Column({ type: 'varchar', name: 'unsellable_on_hand_inventory_cost_currency_code', nullable: true })
  unsellableOnHandInventoryCostCurrencyCode: string;

  @Column({ type: 'int', name: 'unsellable_on_hand_inventory_units', nullable: true })
  unsellableOnHandInventoryUnits: number;

  @Column({ type: 'float', name: 'aged_90_plus_days_sellable_inventory_cost_amount', nullable: true })
  aged90PlusDaysSellableInventoryCostAmount: number;

  @Column({ type: 'varchar', name: 'aged_90_plus_days_sellable_inventory_cost_currency_code', nullable: true })
  aged90PlusDaysSellableInventoryCostCurrencyCode: string;

  @Column({ type: 'int', name: 'aged_90_plus_days_sellable_inventory_units', nullable: true })
  aged90PlusDaysSellableInventoryUnits: number;
}
