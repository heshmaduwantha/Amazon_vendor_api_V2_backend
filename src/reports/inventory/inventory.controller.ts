import { Controller, Get, Query, Logger, BadRequestException } from '@nestjs/common';
import { InventoryService } from './inventory.service';

@Controller('reports')
export class InventoryController {
  private readonly logger = new Logger(InventoryController.name);

  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * GET /reports/inventory/snapshot?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   *
   * Returns all inventory records in the date range plus an aggregated summary.
   * Use to compare against Amazon Vendor Central → Inventory Health.
   *
   * Phase 3 note: records will have per-day start_date / end_date after the PK
   * bug fix is deployed.  Before the fix all rows had the same sync-range dates.
   *
   * Example:
   *   GET /reports/inventory/snapshot?startDate=2026-05-18&endDate=2026-05-24
   */
  @Get('inventory/snapshot')
  async getInventorySnapshot(
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
    return this.inventoryService.queryInventorySnapshot(startDate, endDate);
  }

  /**
   * GET /reports/inventory/by-asin?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   *
   * Returns raw ASIN-level rows from the amazon_inventory_by_asin table.
   *
   * Example:
   *   GET /reports/inventory/by-asin?startDate=2026-05-18&endDate=2026-05-24
   */
  @Get('inventory/by-asin')
  async getInventoryByAsin(
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
    return this.inventoryService.queryInventoryByAsin(startDate, endDate);
  }
}
