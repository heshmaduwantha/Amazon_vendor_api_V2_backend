import {
  getAmazonWeekInfo,
  getLastCompletedAmazonWeek,
  getPreviousCompletedAmazonWeeks,
} from './amazon-week.util';

describe('Amazon week utility', () => {
  it('places Jan 01-03 2026 in the final Amazon week of 2025', () => {
    expect(getAmazonWeekInfo('2026-01-01')).toEqual({
      amazonYear: 2025,
      weekNumber: 52,
      weekStartDate: '2025-12-28',
      weekEndDate: '2026-01-03',
    });
    expect(getAmazonWeekInfo('2026-01-03').amazonYear).toBe(2025);
  });

  it('starts Amazon 2026 Week 01 on Sunday Jan 04', () => {
    expect(getAmazonWeekInfo('2026-01-04')).toEqual({
      amazonYear: 2026,
      weekNumber: 1,
      weekStartDate: '2026-01-04',
      weekEndDate: '2026-01-10',
    });
    expect(getAmazonWeekInfo('2026-01-10').weekNumber).toBe(1);
  });

  it('calculates normal mid-year Sunday-Saturday ranges', () => {
    expect(getAmazonWeekInfo('2026-06-05')).toEqual({
      amazonYear: 2026,
      weekNumber: 22,
      weekStartDate: '2026-05-31',
      weekEndDate: '2026-06-06',
    });
  });

  it('handles year-end transition into the next Amazon year', () => {
    expect(getAmazonWeekInfo('2027-01-02')).toEqual({
      amazonYear: 2026,
      weekNumber: 52,
      weekStartDate: '2026-12-27',
      weekEndDate: '2027-01-02',
    });
    expect(getAmazonWeekInfo('2027-01-03')).toEqual({
      amazonYear: 2027,
      weekNumber: 1,
      weekStartDate: '2027-01-03',
      weekEndDate: '2027-01-09',
    });
  });

  it('returns last and previous completed Amazon weeks', () => {
    expect(getLastCompletedAmazonWeek('2026-06-05')).toMatchObject({
      amazonYear: 2026,
      weekNumber: 21,
      startDate: '2026-05-24',
      endDate: '2026-05-30',
    });

    expect(getPreviousCompletedAmazonWeeks(3, '2026-06-05').map(w => w.label)).toEqual([
      '2026 Week 21',
      '2026 Week 20',
      '2026 Week 19',
    ]);
  });
});
