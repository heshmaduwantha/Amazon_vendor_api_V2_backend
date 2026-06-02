import { Controller, Get, Query } from '@nestjs/common';
import { ForecastService } from './forecast.service';

@Controller('reports')
export class ForecastController {
  constructor(private readonly forecastService: ForecastService) {}

  @Get('forecast/snapshot')
  async getForecastSnapshot(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.forecastService.queryForecastSnapshot(startDate, endDate);
  }
}
