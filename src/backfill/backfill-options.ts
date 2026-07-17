import { resolve } from 'node:path';
import {
  BackfillChunk,
  defaultBackfillStart,
  generateBackwardChunks,
  parseIsoDate,
} from './backfill-date.util';

export interface BackfillOptions {
  startDate: string;
  endDate: string;
  chunkDays: number;
  existingDataStartDate: string;
  dryRun: boolean;
  confirmProd: boolean;
  nonInteractive: boolean;
  resume: boolean;
  overrideSafetyBoundary: boolean;
  forceChunk?: BackfillChunk;
  checkpointPath: string;
  jobId: string;
}

export interface BackfillOptionDefaults {
  checkpointPath: string;
  jobIdPrefix: string;
  useBackfillIdentityEnvironment?: boolean;
  dryRunSupported?: boolean;
}

const INVENTORY_BACKFILL_DEFAULTS: BackfillOptionDefaults = {
  checkpointPath: './amazon-inventory-backfill-checkpoint.json',
  jobIdPrefix: 'amazon-inventory',
};

type ArgumentMap = Map<string, string | boolean>;

function parseArguments(argv: string[]): ArgumentMap {
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--'))
      throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      values.set(rawName, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(rawName, next);
      index++;
    } else {
      values.set(rawName, true);
    }
  }
  return values;
}

function stringValue(
  args: ArgumentMap,
  name: string,
  envName?: string,
  fallback?: string,
): string | undefined {
  const value = args.get(name);
  if (typeof value === 'boolean')
    throw new Error(`--${name} requires a value.`);
  return value ?? (envName ? process.env[envName] : undefined) ?? fallback;
}

function flagValue(args: ArgumentMap, name: string): boolean {
  const value = args.get(name);
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} must be a boolean flag.`);
}

function parseForceChunk(value?: string): BackfillChunk | undefined {
  if (!value) return undefined;
  const [startDate, endDate, extra] = value.split(':');
  if (!startDate || !endDate || extra) {
    throw new Error('--force-chunk must use START_DATE:END_DATE format.');
  }
  parseIsoDate(startDate, 'force chunk start date');
  parseIsoDate(endDate, 'force chunk end date');
  if (startDate > endDate)
    throw new Error('force chunk start date must not be after its end date.');
  return { startDate, endDate };
}

export function parseBackfillOptions(
  argv: string[],
  today = new Date(),
  defaults: BackfillOptionDefaults = INVENTORY_BACKFILL_DEFAULTS,
): BackfillOptions {
  const args = parseArguments(argv);
  const startDate = stringValue(
    args,
    'start-date',
    'AMAZON_BACKFILL_START_DATE',
    defaultBackfillStart(today),
  )!;
  const endDate = stringValue(
    args,
    'end-date',
    'AMAZON_BACKFILL_END_DATE',
    '2025-09-30',
  )!;
  const chunkDaysRaw = stringValue(
    args,
    'chunk-days',
    'AMAZON_BACKFILL_CHUNK_DAYS',
    '15',
  )!;
  const existingDataStartDate = stringValue(
    args,
    'existing-data-start-date',
    'EXISTING_DATA_START_DATE',
    '2025-10-01',
  )!;
  const checkpointPath = resolve(
    stringValue(
      args,
      'checkpoint-path',
      defaults.useBackfillIdentityEnvironment === false
        ? undefined
        : 'BACKFILL_CHECKPOINT_PATH',
      defaults.checkpointPath,
    )!,
  );
  const chunkDays = Number(chunkDaysRaw);

  parseIsoDate(startDate, 'start_date');
  parseIsoDate(endDate, 'end_date');
  parseIsoDate(existingDataStartDate, 'existing_data_start_date');
  if (startDate > endDate)
    throw new Error('start_date must be earlier than or equal to end_date.');
  if (!Number.isInteger(chunkDays) || chunkDays < 1 || chunkDays > 15) {
    throw new Error(
      "chunk_days must be an integer from 1 through Amazon's 15-day limit.",
    );
  }

  const dryRun = flagValue(args, 'dry-run');
  const confirmProd = flagValue(args, 'confirm-prod');
  const nonInteractive = flagValue(args, 'non-interactive');
  const overrideSafetyBoundary = flagValue(args, 'override-safety-boundary');
  const resume = flagValue(args, 'resume');
  const forceChunk = parseForceChunk(
    stringValue(args, 'force-chunk', 'AMAZON_BACKFILL_FORCE_CHUNK'),
  );

  if (dryRun && defaults.dryRunSupported === false) {
    throw new Error(
      'Sales backfill dry-run is not supported because SalesService.syncDailySales performs database upserts.',
    );
  }

  if (!overrideSafetyBoundary && endDate >= existingDataStartDate) {
    throw new Error(
      `end_date ${endDate} reaches protected existing data beginning ${existingDataStartDate}. ` +
        'Use --override-safety-boundary only after explicit review.',
    );
  }
  if (!dryRun && !confirmProd) {
    const dryRunHint =
      defaults.dryRunSupported === false
        ? ''
        : ' Use --dry-run to fetch without writing.';
    throw new Error(`Database writes require --confirm-prod.${dryRunHint}`);
  }
  if (nonInteractive && !confirmProd && !dryRun) {
    throw new Error(
      '--non-interactive requires --confirm-prod for database writes.',
    );
  }

  const chunks = generateBackwardChunks(startDate, endDate, chunkDays);
  if (forceChunk) {
    const found = chunks.some(
      (chunk) =>
        chunk.startDate === forceChunk.startDate &&
        chunk.endDate === forceChunk.endDate,
    );
    if (!found) {
      throw new Error(
        '--force-chunk must exactly match one calculated chunk in the requested range.',
      );
    }
  }

  const jobId = stringValue(
    args,
    'job-id',
    defaults.useBackfillIdentityEnvironment === false
      ? undefined
      : 'AMAZON_BACKFILL_JOB_ID',
    `${defaults.jobIdPrefix}-${startDate}-${endDate}-${chunkDays}d`,
  )!;

  return {
    startDate,
    endDate,
    chunkDays,
    existingDataStartDate,
    dryRun,
    confirmProd,
    nonInteractive,
    resume,
    overrideSafetyBoundary,
    forceChunk,
    checkpointPath,
    jobId,
  };
}

export const BACKFILL_HELP = `Amazon Historical Backfill

Usage:
  npm run backfill:amazon-history -- [options]

Options:
  --start-date YYYY-MM-DD
  --end-date YYYY-MM-DD
  --chunk-days 1..15
  --dry-run
  --confirm-prod
  --non-interactive
  --resume
  --force-chunk YYYY-MM-DD:YYYY-MM-DD
  --override-safety-boundary
  --checkpoint-path PATH
  --job-id ID
`;

export const SALES_BACKFILL_HELP = `Amazon Vendor Sales Historical Backfill

Usage:
  npm run backfill:amazon-sales-history -- [options]

Options:
  --start-date YYYY-MM-DD
  --end-date YYYY-MM-DD
  --chunk-days 1..15
  --confirm-prod
  --non-interactive
  --resume
  --force-chunk YYYY-MM-DD:YYYY-MM-DD
  --override-safety-boundary
  --checkpoint-path PATH
  --job-id ID

Note:
  Sales dry-run is not supported because the existing sales sync performs database upserts.
`;
