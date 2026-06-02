import { IsNotEmpty, IsDateString } from 'class-validator';

export class TestReportDto {
  @IsNotEmpty({ message: 'startDate and endDate are required ISO date strings' })
  @IsDateString({}, { message: 'startDate and endDate are required ISO date strings' })
  startDate: string;

  @IsNotEmpty({ message: 'startDate and endDate are required ISO date strings' })
  @IsDateString({}, { message: 'startDate and endDate are required ISO date strings' })
  endDate: string;
}
