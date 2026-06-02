import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AmazonForecastByAsin } from './entities/amazon-forecast-by-asin.entity';
import { ForecastService } from './forecast.service';
import { ForecastController } from './forecast.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AmazonForecastByAsin])],
  providers: [ForecastService],
  controllers: [ForecastController],
  exports: [ForecastService],
})
export class ForecastModule {}
