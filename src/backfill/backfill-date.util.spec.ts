import {
  assertCompleteCoverage,
  defaultBackfillStart,
  generateBackwardChunks,
} from './backfill-date.util';

describe('backfill date chunks', () => {
  it('generates one exact 15-day chunk', () => {
    expect(generateBackwardChunks('2025-09-16', '2025-09-30', 15)).toEqual([
      { startDate: '2025-09-16', endDate: '2025-09-30' },
    ]);
  });

  it('handles a range shorter than 15 days', () => {
    expect(generateBackwardChunks('2025-09-25', '2025-09-30', 15)).toEqual([
      { startDate: '2025-09-25', endDate: '2025-09-30' },
    ]);
  });

  it('iterates backward across month boundaries with a final partial chunk', () => {
    expect(generateBackwardChunks('2025-08-20', '2025-09-30', 15)).toEqual([
      { startDate: '2025-09-16', endDate: '2025-09-30' },
      { startDate: '2025-09-01', endDate: '2025-09-15' },
      { startDate: '2025-08-20', endDate: '2025-08-31' },
    ]);
  });

  it('handles leap day without gaps', () => {
    const chunks = generateBackwardChunks('2024-02-20', '2024-03-05', 7);
    expect(chunks).toEqual([
      { startDate: '2024-02-28', endDate: '2024-03-05' },
      { startDate: '2024-02-21', endDate: '2024-02-27' },
      { startDate: '2024-02-20', endDate: '2024-02-20' },
    ]);
    expect(() =>
      assertCompleteCoverage(chunks, '2024-02-20', '2024-03-05'),
    ).not.toThrow();
  });

  it('handles a single-day range', () => {
    expect(generateBackwardChunks('2025-01-01', '2025-01-01', 15)).toEqual([
      { startDate: '2025-01-01', endDate: '2025-01-01' },
    ]);
  });

  it('rejects overlap or missing dates', () => {
    expect(() =>
      assertCompleteCoverage(
        [
          { startDate: '2025-01-01', endDate: '2025-01-05' },
          { startDate: '2025-01-05', endDate: '2025-01-10' },
        ],
        '2025-01-01',
        '2025-01-10',
      ),
    ).toThrow('gap or overlap');
  });

  it('clamps a leap-day default start to February 28', () => {
    expect(defaultBackfillStart(new Date('2024-02-29T12:00:00Z'))).toBe(
      '2022-02-28',
    );
  });
});
