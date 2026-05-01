// ============================================================
// US Stock Market Holidays (NYSE)
// Source: https://www.nyse.com/markets/hours-calendars
// Update annually.
// ============================================================

// Full-day market closures for 2026 (Eastern Time)
// Format: YYYY-MM-DD
export const NYSE_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed — July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
];

// Early close days (1:00 PM ET close instead of 4:00 PM)
// We treat these as regular days but you can extend later.
export const NYSE_EARLY_CLOSE_2026 = [
  '2026-07-02', // Day before Independence Day
  '2026-11-27', // Day after Thanksgiving (Black Friday)
  '2026-12-24', // Christmas Eve
];

// Combined list of all closure dates
const ALL_HOLIDAYS = new Set([...NYSE_HOLIDAYS_2026]);

/**
 * Check if a given date (in ET) is a market holiday.
 * @param {string} dateStrET - Format: YYYY-MM-DD (already in ET timezone)
 * @returns {boolean}
 */
export function isHoliday(dateStrET) {
  return ALL_HOLIDAYS.has(dateStrET);
}

/**
 * Check if a given date (in ET) is an early-close day.
 * @param {string} dateStrET - Format: YYYY-MM-DD
 * @returns {boolean}
 */
export function isEarlyCloseDay(dateStrET) {
  return NYSE_EARLY_CLOSE_2026.includes(dateStrET);
}