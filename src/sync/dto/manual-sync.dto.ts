import { IsDateString } from 'class-validator';

export class ManualSyncDto {
  @IsDateString({}, { message: 'startDate must be a valid ISO date string (e.g. 2024-01-15).' })
  startDate: string;

  @IsDateString({}, { message: 'endDate must be a valid ISO date string (e.g. 2024-01-15).' })
  endDate: string;
}
