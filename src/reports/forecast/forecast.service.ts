import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { AmazonForecastByAsin } from './entities/amazon-forecast-by-asin.entity';

@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  constructor(
    @InjectRepository(AmazonForecastByAsin)
    private readonly forecastByAsinRepo: Repository<AmazonForecastByAsin>,
  ) {}

  async queryForecastSnapshot(startDate: string, endDate: string) {
    const rows = await this.forecastByAsinRepo.find({
      where: {
        forecastGenerationDate: Between(startDate, endDate) as any,
      },
    });

    const totalAsins = rows.length;
    const totalMeanForecastUnits = rows.reduce((s, r) => s + (r.meanForecastUnits ?? 0), 0);
    const totalP70Units = rows.reduce((s, r) => s + (r.p70ForecastUnits ?? 0), 0);
    const totalP80Units = rows.reduce((s, r) => s + (r.p80ForecastUnits ?? 0), 0);
    const totalP90Units = rows.reduce((s, r) => s + (r.p90ForecastUnits ?? 0), 0);

    return {
      startDate,
      endDate,
      totalAsins,
      totalMeanForecastUnits,
      totalP70Units,
      totalP80Units,
      totalP90Units,
      rows,
    };
  }
}
