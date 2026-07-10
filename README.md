# Amazon Vendor API Backend

NestJS service for Amazon Vendor Central Sales, Inventory, and Forecast report synchronization.

## Amazon Historical Backfill

### Purpose

`backfill:amazon-history` is an explicit, one-time CLI command for loading historical Amazon Vendor Inventory DAY reports into `amazon_inventory_by_asin`. It uses the existing LWA/SigV4 authentication, Reports API request and polling flow, Inventory transformation, TypeORM mapping, and PostgreSQL `ON CONFLICT` behavior.

The command works backward from the configured end date in inclusive, non-overlapping chunks. Amazon's `GET_VENDOR_INVENTORY_REPORT` DAY period has a 15-day maximum, so `--chunk-days` accepts `1` through `15`. The Reports API returns one downloadable document per created report rather than paginated list results; logs identify that document as API page 1. The shared client still supports `nextToken` pagination for endpoints that provide it.

The backfill is never started by the application, scheduler, deployment, CI, or migration. It runs only through the CLI command below.

### Data Safety

- Default start: current UTC date minus two calendar years.
- Default end: `2025-09-30`.
- Protected existing-data boundary: `2025-10-01`.
- Business key: `(start_date, end_date, asin)`.
- Changed values are updated; identical rows are skipped; missing keys are inserted.
- Each chunk's database comparison and batched UPSERT run in one transaction.
- A failed chunk rolls back fully and remains safe to rerun.
- No rows are deleted.
- Real writes always require `--confirm-prod`, regardless of `NODE_ENV`.
- Dates at or beyond `EXISTING_DATA_START_DATE` are rejected unless `--override-safety-boundary` is explicitly supplied.

### Prerequisites

- Node.js and npm versions compatible with the repository.
- Network access to Amazon SP-API and the report download URLs.
- Production PostgreSQL connectivity from the office laptop.
- Valid LWA refresh-token and optional AWS SigV4 credentials in environment variables.
- `VENDOR_REPORT_PERIOD=DAY` for the historical Inventory workflow.
- A current database backup or snapshot before the production run.

### Environment Variables

Copy the variable names from `.env.example` and supply values outside Git. Never commit `.env`.

| Variable                                                                    | Purpose                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`                       | Existing PostgreSQL connection                                         |
| `NODE_ENV`                                                                  | Printed target environment, normally `production` on the office laptop |
| `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `REFRESH_TOKEN`                       | Existing Amazon LWA authentication                                     |
| `SP_API_AWS_ACCESS_KEY_ID`, `SP_API_AWS_SECRET_ACCESS_KEY`, `AWS_REGION`    | Existing SigV4 credentials when enabled                                |
| `AMAZON_API_BASE_URL`, `MARKETPLACE_ID`                                     | Existing SP-API target configuration                                   |
| `VENDOR_DISTRIBUTOR_VIEW`, `VENDOR_REPORT_PERIOD`, `VENDOR_SELLING_PROGRAM` | Existing Inventory report options                                      |
| `AMAZON_BACKFILL_START_DATE`, `AMAZON_BACKFILL_END_DATE`                    | CLI date defaults                                                      |
| `AMAZON_BACKFILL_CHUNK_DAYS`                                                | Chunk size, maximum 15                                                 |
| `AMAZON_API_MAX_RETRIES`                                                    | Retry count for 429, 500, 502, 503, 504, reset, and timeout failures   |
| `AMAZON_API_TIMEOUT_SECONDS`                                                | Per-request timeout                                                    |
| `EXISTING_DATA_START_DATE`                                                  | Protected boundary, default `2025-10-01`                               |
| `BACKFILL_CHECKPOINT_PATH`                                                  | Local JSON checkpoint path                                             |
| `AMAZON_BACKFILL_JOB_ID`                                                    | Optional stable checkpoint job identifier                              |

Command-line values override environment defaults.

### Commands

Install and validate first:

```bash
npm ci
npm test -- --runInBand
npm run build
```

Dry run calls Amazon, downloads and transforms report records, and compares them with PostgreSQL, but never starts a write transaction:

```bash
npm run backfill:amazon-history -- \
  --start-date 2024-07-10 \
  --end-date 2025-09-30 \
  --chunk-days 15 \
  --dry-run
```

Production execution prints the environment, database host/name, date range, chunk size, and checkpoint path. It then requires typing `BACKFILL`:

```bash
npm run backfill:amazon-history -- \
  --start-date 2024-07-10 \
  --end-date 2025-09-30 \
  --chunk-days 15 \
  --confirm-prod
```

For an approved unattended run, both flags are required:

```bash
npm run backfill:amazon-history -- \
  --start-date 2024-07-10 \
  --end-date 2025-09-30 \
  --chunk-days 15 \
  --confirm-prod \
  --non-interactive
```

Resume skips only chunks checkpointed with `success`; `dry_run`, `running`, and `failed` chunks run again:

```bash
npm run backfill:amazon-history -- \
  --start-date 2024-07-10 \
  --end-date 2025-09-30 \
  --chunk-days 15 \
  --confirm-prod \
  --resume
```

Force one calculated chunk to rerun, even if it previously succeeded:

```bash
npm run backfill:amazon-history -- \
  --start-date 2024-07-10 \
  --end-date 2025-09-30 \
  --chunk-days 15 \
  --force-chunk 2025-09-16:2025-09-30 \
  --confirm-prod
```

Use `npm run backfill:amazon-history -- --help` for the short option reference.

### Checkpoint Behavior

The default local file is `amazon-inventory-backfill-checkpoint.json` and is ignored by Git. Override it with `BACKFILL_CHECKPOINT_PATH` when the file must live in a durable office-laptop folder.

Each chunk records the job ID, inclusive dates, execution start/end timestamps, fetched/transformed/inserted/updated/skipped/failed counts, duplicate key count, zero-data dates, status, and a sanitized error summary. Writes use a temporary file plus atomic rename. A `success` record is saved only after the PostgreSQL transaction commits.

Keep the same date range, chunk size, job ID, and checkpoint path when using `--resume`.

### Expected Logs

Logs are JSON-shaped and include these events:

- `backfill_target`
- `job_start` and `job_finish`
- `chunk_start`, `chunk_finish`, `chunk_failed`, and `chunk_skipped_completed`
- Inventory API document page and fetched row count
- transient retry attempt and delay, with Amazon request ID when available
- transformed, duplicate, inserted, updated, skipped, and zero-data counts
- `reconciliation_counts_by_date`
- `backfill_summary` with failed ranges and total runtime

Credentials, tokens, passwords, report contents, and customer rows are not logged.

### Reconciliation Queries

Counts by date for the historical period:

```sql
SELECT start_date, COUNT(*) AS record_count
FROM amazon_inventory_by_asin
WHERE start_date BETWEEN DATE '2024-07-10' AND DATE '2025-09-30'
GROUP BY start_date
ORDER BY start_date;
```

Duplicate business keys should return no rows:

```sql
SELECT start_date, end_date, asin, COUNT(*) AS duplicate_count
FROM amazon_inventory_by_asin
WHERE start_date BETWEEN DATE '2024-07-10' AND DATE '2025-09-30'
GROUP BY start_date, end_date, asin
HAVING COUNT(*) > 1;
```

Confirm the protected period remains present and review its counts against a saved pre-run result:

```sql
SELECT start_date, COUNT(*) AS record_count
FROM amazon_inventory_by_asin
WHERE start_date >= DATE '2025-10-01'
GROUP BY start_date
ORDER BY start_date;
```

The final command summary distinguishes successful zero-data dates from failed API chunk ranges. For each successful chunk, `inserted + updated + skipped` must equal `transformed`.

### Rollback And Recovery

- If a chunk fails, its transaction is rolled back. Resolve the API or database error and rerun with `--resume`.
- If the process stops, a `running` checkpoint is not considered complete and is rerun safely.
- To repeat one successful chunk after a source correction, use `--force-chunk` with its exact calculated boundaries.
- Do not delete historical rows. The approved recovery mechanism is the idempotent UPSERT or restoration from the pre-run database backup.
- The command exits nonzero when any chunk fails. Preserve the final summary and failed date ranges before retrying.

### Pre-Run Checklist

1. Pull the latest Git branch.
2. Install dependencies with `npm ci`.
3. Configure environment variables without committing secrets.
4. Confirm the printed database host and database name.
5. Test database connectivity.
6. Run automated tests and `npm run build`.
7. Run the full backfill in `--dry-run` mode.
8. Review calculated chunks, fetched counts, duplicate counts, zero-data dates, and failed ranges.
9. Run against production only with `--confirm-prod` and a current backup.

### Post-Run Verification Checklist

1. Run the duplicate business-key query and verify it returns no rows.
2. Compare counts grouped by date with the dry-run and final summary.
3. Inspect the checkpoint records for `success`, `failed`, or unexpected `running` states.
4. Review failed chunk ranges and successful zero-data dates separately.
5. Compare pre-run and post-run counts from `2025-10-01` onward to confirm protected data was not unintentionally changed.
6. Save the final `backfill_summary`, reconciliation output, and checkpoint file with the run record.
