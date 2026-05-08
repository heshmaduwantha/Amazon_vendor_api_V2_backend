import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('amazon_inventory_by_asin')
export class AmazonInventoryByAsin {
  @PrimaryColumn({ type: 'date' })
  start_date: Date;

  @PrimaryColumn({ type: 'date' })
  end_date: Date;

  @PrimaryColumn({ type: 'varchar' })
  asin: string;

  @Column({ type: 'double precision', nullable: true })
  sourceable_product_out_of_stock_rate: number;

  @Column({ type: 'double precision', nullable: true })
  procurable_product_out_of_stock_rate: number;

  @Column({ type: 'int', nullable: true })
  open_purchase_order_units: number;

  @Column({ type: 'double precision', nullable: true })
  receive_fill_rate: number;

  @Column({ type: 'double precision', nullable: true })
  average_vendor_lead_time_days: number;

  @Column({ type: 'double precision', nullable: true })
  sell_through_rate: number;

  @Column({ type: 'int', nullable: true })
  unfilled_customer_ordered_units: number;

  @Column({ type: 'double precision', nullable: true })
  vendor_confirmation_rate: number;

  @Column({ type: 'double precision', nullable: true })
  net_received_inventory_cost_amount: number;

  @Column({ type: 'varchar', nullable: true })
  net_received_inventory_cost_currency_code: string;

  @Column({ type: 'int', nullable: true })
  net_received_inventory_units: number;

  @Column({ type: 'double precision', nullable: true })
  sellable_on_hand_inventory_cost_amount: number;

  @Column({ type: 'varchar', nullable: true })
  sellable_on_hand_inventory_cost_currency_code: string;

  @Column({ type: 'int', nullable: true })
  sellable_on_hand_inventory_units: number;

  @Column({ type: 'double precision', nullable: true })
  unsellable_on_hand_inventory_cost_amount: number;

  @Column({ type: 'varchar', nullable: true })
  unsellable_on_hand_inventory_cost_currency_code: string;

  @Column({ type: 'int', nullable: true })
  unsellable_on_hand_inventory_units: number;

  @Column({ type: 'double precision', nullable: true })
  aged_90_plus_days_sellable_inventory_cost_amount: number;

  @Column({ type: 'varchar', nullable: true })
  aged_90_plus_days_sellable_inventory_cost_currency_code: string;

  @Column({ type: 'int', nullable: true })
  aged_90_plus_days_sellable_inventory_units: number;

  @Column({ type: 'int', nullable: true })
  reportId: number;
}
