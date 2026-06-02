import { Global, Module } from '@nestjs/common';
import { LimiterService } from './limiter.service';

@Global()
@Module({
  providers: [LimiterService],
  exports: [LimiterService],
})
export class CommonModule {}
