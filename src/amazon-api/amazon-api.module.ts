import { Module } from '@nestjs/common';
import { AmazonApiService } from './amazon-api.service';
import { AmazonApiController } from './amazon-api.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [AmazonApiService],
  controllers: [AmazonApiController],
  exports: [AmazonApiService]
})
export class AmazonApiModule {}
