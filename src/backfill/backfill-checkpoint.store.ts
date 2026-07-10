import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BackfillChunk, chunkKey } from './backfill-date.util';

export type BackfillChunkStatus = 'running' | 'success' | 'failed' | 'dry_run';

export interface BackfillChunkCheckpoint extends BackfillChunk {
  executionStartedAt: string;
  executionEndedAt: string | null;
  fetchedCount: number;
  transformedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  duplicateBusinessKeyCount: number;
  zeroDataDates: string[];
  status: BackfillChunkStatus;
  errorSummary: string | null;
}

interface BackfillJobCheckpoint {
  jobId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  chunkDays: number;
  chunks: Record<string, BackfillChunkCheckpoint>;
}

interface CheckpointFile {
  version: 1;
  jobs: Record<string, BackfillJobCheckpoint>;
}

const EMPTY_CHECKPOINT: CheckpointFile = { version: 1, jobs: {} };

export class BackfillCheckpointStore {
  private state: CheckpointFile = structuredClone(EMPTY_CHECKPOINT);

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as CheckpointFile;
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
      this.state = structuredClone(EMPTY_CHECKPOINT);
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

  async record(
    jobId: string,
    checkpoint: BackfillChunkCheckpoint,
  ): Promise<void> {
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
