import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('manual')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualSync(@Body() body: { startDate: string; endDate: string }) {
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return {
        message: 'startDate and endDate are required in the request body.',
        status: HttpStatus.BAD_REQUEST,
      };
    }

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
