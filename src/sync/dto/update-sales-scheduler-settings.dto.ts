import { IsBoolean, IsInt, IsOptional, IsString, Max, Min, Matches } from 'class-validator';

export class UpdateSalesSchedulerSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'timeOfDay must use HH:mm 24-hour format.',
  })
  timeOfDay: string;

  @IsString()
  timezone: string;
}
