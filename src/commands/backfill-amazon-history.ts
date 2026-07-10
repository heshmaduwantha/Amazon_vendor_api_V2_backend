import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AmazonHistoryBackfillService } from '../backfill/amazon-history-backfill.service';
import { BackfillCliModule } from '../backfill/backfill-cli.module';
import {
  BACKFILL_HELP,
  parseBackfillOptions,
} from '../backfill/backfill-options';

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
    console.log(BACKFILL_HELP);
    return;
  }

  const app = await NestFactory.createApplicationContext(BackfillCliModule);
  try {
    const config = app.get(ConfigService);
    const options = parseBackfillOptions(process.argv.slice(2));
    const target = {
      environment: config.get<string>('NODE_ENV') || 'development',
      databaseHost: config.getOrThrow<string>('DB_HOST'),
      databaseName: config.getOrThrow<string>('DB_NAME'),
      startDate: options.startDate,
      endDate: options.endDate,
      chunkDays: options.chunkDays,
      existingDataStartDate: options.existingDataStartDate,
      dryRun: options.dryRun,
      checkpointPath: options.checkpointPath,
    };
    console.log(
      JSON.stringify({ event: 'backfill_target', ...target }, null, 2),
    );

    if (
      !options.dryRun &&
      !options.nonInteractive &&
      !(await confirmExecution())
    ) {
      throw new Error(
        'Production write confirmation was not provided. No API chunks were processed.',
      );
    }

    const summary = await app.get(AmazonHistoryBackfillService).run(options);
    console.log(
      JSON.stringify({ event: 'backfill_summary', ...summary }, null, 2),
    );
    if (summary.failedChunks > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  new Logger('AmazonHistoryBackfillCommand').error(message);
  process.exitCode = 1;
});
