import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SyncService } from './sync.service';
import { ManualSyncDto } from './dto/manual-sync.dto';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('status')
  async getStatus() {
    return await this.syncService.getSyncStatus();
  }

  @Post('manual')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualSync(@Body() body: ManualSyncDto) {
    const { startDate, endDate } = body;

    // Fire and forget so we don't hold the HTTP connection open for large syncs
    this.syncService.executeSync(startDate, endDate).catch(() => {
      // Errors are logged inside executeSync
    });

    return {
      message: `Manual sync initiated for period: ${startDate} to ${endDate}. Please check the server logs for progress.`,
      status: HttpStatus.ACCEPTED,
    };
  }
}
