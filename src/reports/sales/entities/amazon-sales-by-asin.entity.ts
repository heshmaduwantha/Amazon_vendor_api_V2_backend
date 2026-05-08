import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('amazon_sales_by_asin')
export class AmazonSalesByAsin {
  @PrimaryColumn({ type: 'date' })
  start_date: Date;

  @PrimaryColumn({ type: 'date' })
  end_date: Date;

  @PrimaryColumn({ type: 'varchar' })
  asin: string;

  @Column({ type: 'int', default: 0 })
  customer_returns: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  shipped_cogs_amount: number;

  @Column({ type: 'varchar', default: 'USD' })
  shipped_cogs_currency: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  shipped_revenue_amount: number;

  @Column({ type: 'varchar', default: 'USD' })
  shipped_revenue_currency: string;

  @Column({ type: 'int', default: 0 })
  shipped_units: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  ordered_revenue_amount: number;

  @Column({ type: 'varchar', default: 'USD' })
  ordered_revenue_currency: string;

  @Column({ type: 'int', default: 0 })
  ordered_units: number;
}
