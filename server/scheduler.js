// ============================================================
// Smart Market-Aware Scheduler
// Determines refresh interval based on US market hours (ET),
// weekends, and NYSE holidays. Server can be in any timezone —
// we always normalize to America/New_York for market checks.
// ============================================================

import { isHoliday, isEarlyCloseDay } from './holidays.js';

// Market session intervals (in milliseconds)
const REFRESH_REGULAR    = 60 * 1000;        // 60 sec during regular hours
const REFRESH_EXTENDED   = 5 * 60 * 1000;    // 5 min during pre/post market
const REFRESH_CLOSED     = null;             // No auto-refresh when closed

// Market sessions in ET (24-hour format, minutes since midnight)
const PRE_MARKET_START   = 4 * 60;          // 4:00 AM ET
const REGULAR_OPEN       = 9 * 60 + 30;     // 9:30 AM ET
const REGULAR_CLOSE      = 16 * 60;         // 4:00 PM ET
const AFTER_HOURS_END    = 20 * 60;         // 8:00 PM ET

/**
 * Get the current date/time in America/New_York timezone.
 * Returns: { dateStr: 'YYYY-MM-DD', minutes: <minutes since midnight ET>, dayOfWeek: 0-6 }
 */
function getETInfo(now = new Date()) {
  // Use Intl.DateTimeFormat for bulletproof timezone conversion (handles DST automatically)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short'
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(now).map(p => [p.type, p.value])
  );

  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  let hour = parseInt(parts.hour, 10);
  // Edge case: Intl returns "24" for midnight in some Node versions
  if (hour === 24) hour = 0;
  const minute = parseInt(parts.minute, 10);
  const minutes = hour * 60 + minute;

  // Day of week: 0=Sunday ... 6=Saturday
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[parts.weekday];

  return { dateStr, minutes, dayOfWeek, hour, minute };
}

/**
 * Determine the current market phase.
 * Returns one of: 'regular' | 'pre-market' | 'after-hours' | 'closed'
 */
export function getMarketPhase(now = new Date()) {
  const { dateStr, minutes, dayOfWeek } = getETInfo(now);

  // Weekend → closed
  if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';

  // Holiday → closed
  if (isHoliday(dateStr)) return 'closed';

  // Determine close time (early-close days end at 1 PM ET)
  const closeMinute = isEarlyCloseDay(dateStr) ? 13 * 60 : REGULAR_CLOSE;

  // Within regular session
  if (minutes >= REGULAR_OPEN && minutes < closeMinute) return 'regular';

  // Pre-market: 4:00 AM – 9:30 AM
  if (minutes >= PRE_MARKET_START && minutes < REGULAR_OPEN) return 'pre-market';

  // After-hours: 4:00 PM – 8:00 PM
  if (minutes >= closeMinute && minutes < AFTER_HOURS_END) return 'after-hours';

  // Otherwise (8 PM – 4 AM ET) → closed
  return 'closed';
}

/**
 * Get the refresh interval (in ms) for current market phase.
 * Returns null if no auto-refresh should happen.
 */
export function getRefreshInterval(phase = getMarketPhase()) {
  switch (phase) {
    case 'regular':       return REFRESH_REGULAR;
    case 'pre-market':
    case 'after-hours':   return REFRESH_EXTENDED;
    case 'closed':        return REFRESH_CLOSED;
    default:              return REFRESH_CLOSED;
  }
}

/**
 * Human-readable label for the current phase.
 */
export function getPhaseLabel(phase = getMarketPhase()) {
  return ({
    'regular':     '🟢 Market Open (regular hours)',
    'pre-market':  '🟡 Pre-Market',
    'after-hours': '🟡 After-Hours',
    'closed':      '🌙 Market Closed'
  })[phase] || phase;
}

/**
 * Format current ET time as a human string (for logging).
 */
export function getETTimeString(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZoneName: 'short'
  });
  return fmt.format(now);
}

/**
 * Adaptive scheduler.
 * Calls runFetchFn() according to the current market phase.
 * Re-evaluates phase after every fetch — handles transitions automatically.
 *
 * Returns a `stop()` function to cancel the scheduler.
 *
 * @param {Function} runFetchFn - async function to call (e.g., runFetch from fetcher.js)
 * @param {Function} [onPhaseChange] - optional callback(phase) for UI/logging
 */
export function startSmartScheduler(runFetchFn, onPhaseChange) {
  let timer = null;
  let lastPhase = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;

    const phase = getMarketPhase();
    if (phase !== lastPhase) {
      console.log(`📅 Phase change: ${lastPhase ?? 'init'} → ${phase} (ET: ${getETTimeString()})`);
      lastPhase = phase;
      if (onPhaseChange) onPhaseChange(phase);
    }

    const interval = getRefreshInterval(phase);

    if (interval === null) {
      // Market closed — don't schedule next fetch, but re-check every 5 min for phase transitions
      console.log(`💤 Market closed — sleeping. Next phase check in 5 min.`);
      timer = setTimeout(tick, 5 * 60 * 1000);
      return;
    }

    // Run the fetch
    try {
      await runFetchFn();
    } catch (e) {
      console.error('❌ Fetch error in scheduler:', e.message);
    }

    if (stopped) return;

    // Schedule next fetch based on current phase
    timer = setTimeout(tick, interval);
  }

  // Kick off
  tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      console.log('🛑 Scheduler stopped');
    },
    getPhase: () => lastPhase
  };
}