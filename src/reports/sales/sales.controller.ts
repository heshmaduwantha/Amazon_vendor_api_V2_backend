import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Logger,
  ForbiddenException,
  BadRequestException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmazonApiService } from '../../amazon-api/amazon-api.service';
import { SalesService } from './sales.service';
import { TestReportDto } from './dto/test-report.dto';

@Controller('reports')
export class SalesController {
  private readonly logger = new Logger(SalesController.name);

  constructor(
    private readonly salesService: SalesService,
    private readonly amazonApiService: AmazonApiService,
    private readonly configService: ConfigService,
  ) {}

  // ── Phase 3: Data Tally — Production Query Endpoint ──────────────────────

  /**
   * GET /reports/sales/summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   *
   * Returns daily aggregate rows + summed totals from the local DB.
   * Use to compare against Amazon Vendor Central → Sales → Summary.
   *
   * Example:
   *   GET /reports/sales/summary?startDate=2026-05-18&endDate=2026-05-24
   */
  @Get('sales/summary')
  async getSalesSummary(
    @Query('startDate') startDate: string,
    @Query('endDate')   endDate:   string,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException(
        'startDate and endDate query params are required (format: YYYY-MM-DD)',
      );
    }
    if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      throw new BadRequestException('startDate and endDate must be valid dates (YYYY-MM-DD)');
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new BadRequestException('endDate cannot be earlier than startDate');
    }
    return this.salesService.querySalesSummary(startDate, endDate);
  }

  /**
   * GET /reports/sales/by-asin?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   *
   * Returns raw ASIN-level rows from the amazon_sales_by_asin table.
   *
   * Example:
   *   GET /reports/sales/by-asin?startDate=2026-05-18&endDate=2026-05-24
   */
  @Get('sales/by-asin')
  async getSalesByAsin(
    @Query('startDate') startDate: string,
    @Query('endDate')   endDate:   string,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException(
        'startDate and endDate query params are required (format: YYYY-MM-DD)',
      );
    }
    if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      throw new BadRequestException('startDate and endDate must be valid dates (YYYY-MM-DD)');
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new BadRequestException('endDate cannot be earlier than startDate');
    }
    return this.salesService.querySalesByAsin(startDate, endDate);
  }

  // ── Dev / Test Endpoint ───────────────────────────────────────────────────

  /**
   * POST /reports/test-sales-report
   * Disabled in production. Used during development to verify the raw
   * SP-API report flow without writing to the database.
   */
  @Post('test-sales-report')
  @UsePipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors) => ({
      statusCode: 400,
      message: 'startDate and endDate are required ISO date strings',
      errors: errors.map(e => ({ property: e.property, constraints: e.constraints })),
    }),
  }))
  async testSalesReport(@Body() body: TestReportDto) {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new ForbiddenException('Experimental report test is disabled in production.');
    }

    const { startDate, endDate } = body;
    const marketplaceId = this.configService.get<string>('MARKETPLACE_ID') || 'ATVPDKIKX0DER';
    const reportType    = 'GET_VENDOR_SALES_REPORT';
    const reportOptions = { reportPeriod: 'DAY', distributorView: 'SOURCING', sellingProgram: 'RETAIL' };

    this.logger.log(`[Test] Sales Report. Dates: ${startDate} → ${endDate}`);

    try {
      const { reportId } = await this.amazonApiService.createReport(
        reportType, [marketplaceId],
        this.amazonApiService.normalizeDate(startDate, 'start'),
        this.amazonApiService.normalizeDate(endDate,   'end'),
        reportOptions,
      );

      let reportStatus   = 'IN_QUEUE';
      let reportDocumentId = '';
      const MAX_ATTEMPTS   = 20;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const report = await this.amazonApiService.getReport(reportId);
        reportStatus = report.processingStatus;
        this.logger.debug(`Poll ${attempt + 1}/${MAX_ATTEMPTS}: ${reportStatus}`);

        if (reportStatus === 'DONE') { reportDocumentId = report.reportDocumentId; break; }
        if (['CANCELLED', 'FATAL'].includes(reportStatus))
          throw new Error(`Report failed with status: ${reportStatus}`);

        await new Promise(r => setTimeout(r, 10_000));
      }

      if (reportStatus !== 'DONE') {
        return { ok: false, reportId, reportType, status: reportStatus, message: 'Timeout.' };
      }

      const document   = await this.amazonApiService.getReportDocument(reportDocumentId);
      const rawContent = await this.amazonApiService.downloadAndParseReport(
        document.url, document.compressionAlgorithm,
      );

      let parsedRows: any[] = Array.isArray(rawContent) ? rawContent : [];
      const rowCount  = parsedRows.length;
      const sampleRow = rowCount > 0 ? { ...parsedRows[0] } : null;

      return { ok: true, reportId, reportType, status: reportStatus, rowCount, sampleRow };

    } catch (error: any) {
      const status          = error.response?.status;
      const amazonErrorCode = error.response?.data?.errors?.[0]?.code    || 'UNKNOWN';
      const reason          = error.response?.data?.errors?.[0]?.message || error.message;
      this.logger.error(`[Test] Failed. Status: ${status}, Code: ${amazonErrorCode}, Reason: ${reason}`);
      return { ok: false, reportType, status, amazonErrorCode, reason };
    }
  }
}
