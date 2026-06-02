import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('amazon_sales_by_asin')
export class AmazonSalesByAsin {
  @PrimaryColumn({ type: 'varchar', name: 'start_date' })
  startDate: string;

  @PrimaryColumn({ type: 'varchar', name: 'end_date' })
  endDate: string;

  @PrimaryColumn({ type: 'varchar' })
  asin: string;

  @Column({ type: 'int', name: 'customer_returns', default: 0 })
  customerReturns: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'shipped_cogs_amount', default: 0.0 })
  shippedCogsAmount: number;

  @Column({ type: 'varchar', name: 'shipped_cogs_currency', default: 'USD' })
  shippedCogsCurrency: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'shipped_revenue_amount', default: 0.0 })
  shippedRevenueAmount: number;

  @Column({ type: 'varchar', name: 'shipped_revenue_currency', default: 'USD' })
  shippedRevenueCurrency: string;

  @Column({ type: 'int', name: 'shipped_units', default: 0 })
  shippedUnits: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'ordered_revenue_amount', default: 0.0 })
  orderedRevenueAmount: number;

  @Column({ type: 'varchar', name: 'ordered_revenue_currency', default: 'USD' })
  orderedRevenueCurrency: string;

  @Column({ type: 'int', name: 'ordered_units', default: 0 })
  orderedUnits: number;
}
