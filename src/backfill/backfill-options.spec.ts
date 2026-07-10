import { parseBackfillOptions } from './backfill-options';

describe('backfill options safety', () => {
  const baseArguments = [
    '--start-date',
    '2025-09-01',
    '--end-date',
    '2025-09-30',
    '--chunk-days',
    '15',
  ];

  it('requires explicit confirmation for database writes', () => {
    expect(() => parseBackfillOptions(baseArguments)).toThrow('--confirm-prod');
  });

  it('allows a dry run without production confirmation', () => {
    expect(parseBackfillOptions([...baseArguments, '--dry-run'])).toEqual(
      expect.objectContaining({ dryRun: true, confirmProd: false }),
    );
  });

  it('rejects dates at the protected existing-data boundary', () => {
    expect(() =>
      parseBackfillOptions([
        '--start-date',
        '2025-09-16',
        '--end-date',
        '2025-10-01',
        '--dry-run',
      ]),
    ).toThrow('protected existing data');
  });

  it('accepts a force range only when it exactly matches a calculated chunk', () => {
    expect(
      parseBackfillOptions([
        ...baseArguments,
        '--dry-run',
        '--force-chunk',
        '2025-09-16:2025-09-30',
      ]).forceChunk,
    ).toEqual({ startDate: '2025-09-16', endDate: '2025-09-30' });

    expect(() =>
      parseBackfillOptions([
        ...baseArguments,
        '--dry-run',
        '--force-chunk',
        '2025-09-15:2025-09-30',
      ]),
    ).toThrow('exactly match');
  });
});
