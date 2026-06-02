import { IsDateString, IsIn, IsOptional } from 'class-validator';

export class ManualSyncDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsIn(['sales', 'inventory', 'both'])
  reportType?: 'sales' | 'inventory' | 'both';
}
