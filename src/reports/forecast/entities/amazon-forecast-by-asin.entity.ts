import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('amazon_forecast_by_asin')
export class AmazonForecastByAsin {
  @PrimaryColumn({ type: 'date', name: 'forecast_generation_date' })
  forecastGenerationDate: string;

  @PrimaryColumn({ type: 'varchar' })
  asin: string;

  @Column({ type: 'date', name: 'start_date', nullable: true })
  startDate: string;

  @Column({ type: 'date', name: 'end_date', nullable: true })
  endDate: string;

  @Column({ type: 'int', name: 'mean_forecast_units', default: 0 })
  meanForecastUnits: number;

  @Column({ type: 'int', name: 'p70_forecast_units', default: 0 })
  p70ForecastUnits: number;

  @Column({ type: 'int', name: 'p80_forecast_units', default: 0 })
  p80ForecastUnits: number;

  @Column({ type: 'int', name: 'p90_forecast_units', default: 0 })
  p90ForecastUnits: number;
}
