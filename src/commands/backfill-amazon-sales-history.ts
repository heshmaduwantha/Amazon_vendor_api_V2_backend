import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { AmazonSalesHistoryBackfillService } from '../backfill/amazon-sales-history-backfill.service';
import { BackfillCliModule } from '../backfill/backfill-cli.module';
import {
  parseBackfillOptions,
  SALES_BACKFILL_HELP,
} from '../backfill/backfill-options';

const SALES_BACKFILL_DEFAULTS = {
  checkpointPath: './amazon-sales-backfill-checkpoint.json',
  jobIdPrefix: 'amazon-sales',
  useBackfillIdentityEnvironment: false,
  dryRunSupported: false,
};

async function confirmExecution(): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(
      'Type BACKFILL to confirm production database writes: ',
    );
    return answer.trim() === 'BACKFILL';
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(SALES_BACKFILL_HELP);
    return;
  }

  const app = await NestFactory.createApplicationContext(BackfillCliModule);
  try {
    const config = app.get(ConfigService);
    const options = parseBackfillOptions(
      process.argv.slice(2),
      new Date(),
      SALES_BACKFILL_DEFAULTS,
    );
    if (options.dryRun) {
      throw new Error(
        'Sales backfill dry-run is not supported because SalesService.syncDailySales performs database upserts.',
      );
    }

    console.log(
      JSON.stringify(
        {
          event: 'sales_backfill_target',
          NODE_ENV: config.get<string>('NODE_ENV') || 'development',
          DB_HOST: config.getOrThrow<string>('DB_HOST'),
          DB_NAME: config.getOrThrow<string>('DB_NAME'),
          startDate: options.startDate,
          endDate: options.endDate,
          chunkDays: options.chunkDays,
          checkpointPath: options.checkpointPath,
        },
        null,
        2,
      ),
    );

    if (!options.nonInteractive && !(await confirmExecution())) {
      throw new Error(
        'Production write confirmation was not provided. No API chunks were processed.',
      );
    }

    const summary = await app
      .get(AmazonSalesHistoryBackfillService)
      .run(options);
    console.log(
      JSON.stringify({ event: 'sales_backfill_summary', ...summary }, null, 2),
    );
    if (summary.failedChunks > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  new Logger('AmazonSalesHistoryBackfillCommand').error(message);
  process.exitCode = 1;
});
