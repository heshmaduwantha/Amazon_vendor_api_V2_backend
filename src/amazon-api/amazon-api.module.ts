import { Module } from '@nestjs/common';
import { AmazonApiService } from './amazon-api.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [AmazonApiService],
  exports: [AmazonApiService]
})
export class AmazonApiModule {}
