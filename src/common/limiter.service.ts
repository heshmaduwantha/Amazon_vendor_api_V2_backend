import { Injectable } from '@nestjs/common';
import Bottleneck from 'bottleneck';

@Injectable()
export class LimiterService {
  /**
   * getReportDocument — burst: 15, rate: 1/60s
   * minTime = 120s to stay safe within burst limit
   */
  readonly documentLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 120_000,
  });

  /**
   * createReport — rate: 1/60s
   */
  readonly createReportLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 65_000,
  });

  /**
   * getReport (poll) — rate: 2/s, conservative
   */
  readonly reportStatusLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 700,
  });

  /**
   * getReports (list) — rate: 0.0222/s
   */
  readonly listReportsLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 45_000,
  });
}
