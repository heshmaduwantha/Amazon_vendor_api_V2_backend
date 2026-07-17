import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BackfillChunk, chunkKey } from './backfill-date.util';

export type BackfillChunkStatus = 'running' | 'success' | 'failed' | 'dry_run';

export interface BaseBackfillChunkCheckpoint extends BackfillChunk {
  executionStartedAt: string;
  executionEndedAt: string | null;
  status: BackfillChunkStatus;
  errorSummary: string | null;
}

export interface BackfillChunkCheckpoint extends BaseBackfillChunkCheckpoint {
  fetchedCount: number;
  transformedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  duplicateBusinessKeyCount: number;
  zeroDataDates: string[];
}

interface BackfillJobCheckpoint<
  TChunkCheckpoint extends BaseBackfillChunkCheckpoint,
> {
  jobId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  chunkDays: number;
  chunks: Record<string, TChunkCheckpoint>;
}

interface CheckpointFile<TChunkCheckpoint extends BaseBackfillChunkCheckpoint> {
  version: 1;
  jobs: Record<string, BackfillJobCheckpoint<TChunkCheckpoint>>;
}

export class BackfillCheckpointStore<
  TChunkCheckpoint extends BaseBackfillChunkCheckpoint =
    BackfillChunkCheckpoint,
> {
  private state: CheckpointFile<TChunkCheckpoint> = { version: 1, jobs: {} };

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as CheckpointFile<TChunkCheckpoint>;
      if (parsed.version !== 1 || !parsed.jobs)
        throw new Error('unsupported checkpoint format');
      this.state = parsed;
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
      if (code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read checkpoint ${this.path}: ${message}`);
      }
      this.state = { version: 1, jobs: {} };
    }
  }

  initializeJob(
    jobId: string,
    startDate: string,
    endDate: string,
    chunkDays: number,
  ): void {
    const existing = this.state.jobs[jobId];
    if (existing) {
      if (
        existing.requestedStartDate !== startDate ||
        existing.requestedEndDate !== endDate ||
        existing.chunkDays !== chunkDays
      ) {
        throw new Error(
          `Checkpoint job ${jobId} belongs to a different date range or chunk size.`,
        );
      }
      return;
    }
    this.state.jobs[jobId] = {
      jobId,
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      chunkDays,
      chunks: {},
    };
  }

  isSuccessful(jobId: string, chunk: BackfillChunk): boolean {
    return (
      this.state.jobs[jobId]?.chunks[chunkKey(chunk)]?.status === 'success'
    );
  }

  async record(jobId: string, checkpoint: TChunkCheckpoint): Promise<void> {
    const job = this.state.jobs[jobId];
    if (!job)
      throw new Error(`Checkpoint job ${jobId} has not been initialized.`);
    job.chunks[chunkKey(checkpoint)] = checkpoint;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}
