/**
 * @file Code.gs
 * @description Automatically blocks availability on Cal.com using Date Overrides
 * when a Google Calendar has a significant number of busy minutes within a defined
 * daily time window, over the next N days.
 *
 * How it works:
 * 1. Reads your Cal.com schedule (default or a specific one) to find which
 *    weekdays have availability configured.
 * 2. Fetches events from Google Calendar for each upcoming available day.
 * 3. Sums the busy minutes within the configured time window (e.g., 09:00–18:00),
 *    merging overlapping events to avoid double-counting.
 * 4. If busy minutes >= THRESHOLD_MINUTES, that date is added as a Cal.com
 *    Date Override with startTime == endTime == "00:00", which marks the day
 *    as fully unavailable.
 * 5. Existing overrides are preserved; only new dates are appended.
 * 6. A single PATCH request updates the schedule on Cal.com.
 *
 * Required Script Properties (set in Project Settings → Script Properties):
 * - CALENDAR_ID     (required)  → Google Calendar ID to read events from
 * - CAL             (required)  → Cal.com API key (e.g., cal_live_...)
 * - CAL_SCHEDULE_ID (optional)  → Cal.com schedule ID; omit to use the default schedule
 * - CAL_API_VERSION (optional)  → Cal.com API version header; defaults to "2024-06-11"
 *
 * Required Advanced Service: Google Calendar API
 * (Apps Script editor → Services → Google Calendar API → Enable)
 *
 * Trigger: add a time-driven trigger for everyMorning() to run daily,
 * or run previewDryRun() manually to test without writing to Cal.com.
 *
 * License: MIT
 * Created with the assistance of ChatGPT and Claude.
 */

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

const CONFIG = {
  /** IANA timezone used for all date/time calculations. */
  TIMEZONE: 'America/Sao_Paulo',

  /**
   * Number of days ahead (starting from today) to inspect.
   * Days that already have a Cal.com override are skipped.
   */
  DAYS_AHEAD: 14,

  /**
   * Start of the daily window to measure busy time.
   * Events outside this window are ignored.
   * Format: { hour: number, minute: number }
   */
  WINDOW_START: { hour: 9, minute: 0 },

  /**
   * End of the daily window to measure busy time.
   * Format: { hour: number, minute: number }
   */
  WINDOW_END: { hour: 18, minute: 0 },

  /**
   * Minimum busy minutes within the window that triggers a Cal.com block.
   * Example: 180 means 3 hours of confirmed busy time will block the day.
   */
  THRESHOLD_MINUTES: 180,

  /**
   * Events tagged with this string (in title or description) are excluded
   * from the busy-time calculation.
   * Set to null or '' to disable.
   */
  EXCLUDE_TAG: '#noquota',

  /**
   * If true, the script logs what it would do but does NOT write to Cal.com.
   * Useful for testing. Can also be toggled by calling previewDryRun().
   */
  DRY_RUN: false,
};

// ---------------------------------------------------------------------------
// ENTRYPOINT
// ---------------------------------------------------------------------------

/**
 * Main function. Intended to be run daily via a time-driven trigger.
 * Reads Google Calendar busy time and blocks dates on Cal.com as needed.
 */
function everyMorning() {
  const props = PropertiesService.getScriptProperties();
  const calendarId  = mustGetProp_(props, 'CALENDAR_ID');
  const calApiKey   = mustGetProp_(props, 'CAL');
  const calApiVersion = props.getProperty('CAL_API_VERSION') || '2024-06-11';
  const scheduleIdProp = props.getProperty('CAL_SCHEDULE_ID');

  // Step 1: Fetch the Cal.com schedule (default or specific ID).
  const schedule   = getCalSchedule_(calApiKey, calApiVersion, scheduleIdProp);
  const scheduleId = schedule.id;

  // Step 2: Determine which ISO weekdays (1=Mon … 7=Sun) have Cal.com availability.
  const availableIsoWeekdays = getAvailableIsoWeekdaysFromCal_(schedule.availability);

  // Step 3: Build a set of dates that already have an override (skip those).
  const existingOverrideDates = new Set(
    (schedule.overrides || []).map(o => o.date)
  );

  const tz    = CONFIG.TIMEZONE;
  const today = startOfDayTz_(new Date(), tz);
  const datesToBlock = [];

  for (let d = 0; d < CONFIG.DAYS_AHEAD; d++) {
    const day = new Date(today.getTime());
    day.setDate(day.getDate() + d);

    const isoDate    = Utilities.formatDate(day, tz, 'yyyy-MM-dd');
    const isoWeekday = isoWeekday_(day, tz); // 1 (Monday) … 7 (Sunday)

    // Skip days with no Cal.com availability configured.
    if (!availableIsoWeekdays.has(isoWeekday)) continue;

    // Skip dates that already have a manual override.
    if (existingOverrideDates.has(isoDate)) continue;

    // Step 4: Sum busy minutes within the configured window.
    const busyMinutes = sumBusyMinutesWithinWindow_(
      calendarId, day, tz, CONFIG.WINDOW_START, CONFIG.WINDOW_END
    );

    if (busyMinutes >= CONFIG.THRESHOLD_MINUTES) {
      datesToBlock.push(isoDate);
    }
  }

  if (datesToBlock.length === 0) {
    console.log('No date reached the busy threshold. Nothing to block.');
    return;
  }

  // Step 5: Merge existing overrides with new ones (deduplicated by date).
  const overrideByDate = new Map();

  for (const o of (schedule.overrides || [])) {
    if (o && o.date) {
      // Preserve existing overrides, ensuring startTime/endTime are present.
      overrideByDate.set(o.date, {
        date:      o.date,
        startTime: (typeof o.startTime === 'string' && o.startTime) ? o.startTime : '00:00',
        endTime:   (typeof o.endTime   === 'string' && o.endTime)   ? o.endTime   : '00:00',
      });
    }
  }

  for (const date of datesToBlock) {
    if (!overrideByDate.has(date)) {
      // startTime === endTime === "00:00" signals "unavailable all day" in Cal.com.
      overrideByDate.set(date, { date, startTime: '00:00', endTime: '00:00' });
    }
  }

  // Sort overrides chronologically before sending to Cal.com.
  const mergedOverrides = Array.from(overrideByDate.values())
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  console.log('Dates to block:', datesToBlock.join(', '));

  if (CONFIG.DRY_RUN) {
    console.log('DRY_RUN enabled — PATCH request skipped.');
    return;
  }

  // Step 6: Send the PATCH request to update the schedule on Cal.com.
  patchCalSchedule_(calApiKey, calApiVersion, scheduleId, {
    name:         schedule.name,
    timeZone:     schedule.timeZone,
    availability: schedule.availability,
    isDefault:    !!schedule.isDefault,
    overrides:    mergedOverrides,
  });

  console.log(`Cal.com override applied for: ${datesToBlock.join(', ')}`);
}

// ---------------------------------------------------------------------------
// GOOGLE CALENDAR — busy-time calculation
// ---------------------------------------------------------------------------

/**
 * Returns the total number of confirmed busy minutes for a given day,
 * restricted to the time window [windowStart, windowEnd], with overlapping
 * events merged so they are not double-counted.
 *
 * Events are excluded when:
 * - status is not "confirmed"
 * - transparency is "transparent" (marked as "Free" in Google Calendar)
 * - title or description contains CONFIG.EXCLUDE_TAG (if set)
 *
 * @param {string} calendarId  - Google Calendar ID.
 * @param {Date}   day         - Any moment within the target day.
 * @param {string} tz          - IANA timezone string.
 * @param {{hour:number, minute:number}} windowStart - Start of the measurement window.
 * @param {{hour:number, minute:number}} windowEnd   - End of the measurement window.
 * @returns {number} Total busy minutes (non-negative integer).
 */
function sumBusyMinutesWithinWindow_(calendarId, day, tz, windowStart, windowEnd) {
  const dayStr = Utilities.formatDate(day, tz, 'yyyy-MM-dd');
  const offset = Utilities.formatDate(day, tz, 'XXX'); // e.g., "-03:00"

  const winStart = new Date(
    `${dayStr}T${pad2_(windowStart.hour)}:${pad2_(windowStart.minute)}:00${offset}`
  );
  const winEnd = new Date(
    `${dayStr}T${pad2_(windowEnd.hour)}:${pad2_(windowEnd.minute)}:00${offset}`
  );

  // Fetch all events within the window, handling pagination.
  const params = {
    timeMin:      winStart.toISOString(),
    timeMax:      winEnd.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    fields:       'items(start,end,summary,description,transparency,status),nextPageToken',
    maxResults:   2500,
  };

  let items = [];
  let pageToken;
  do {
    const resp = Calendar.Events.list(
      calendarId,
      Object.assign({}, params, { pageToken })
    );
    if (resp.items && resp.items.length) items = items.concat(resp.items);
    pageToken = resp.nextPageToken;
  } while (pageToken);

  // Build a list of [start, end] intervals for qualifying events.
  const intervals = [];

  for (const evt of items) {
    // Skip cancelled or tentative events.
    if (evt.status && evt.status !== 'confirmed') continue;

    // Skip events marked as "Free" (transparent).
    if (evt.transparency === 'transparent') continue;

    const title = evt.summary     || '';
    const desc  = evt.description || '';

    // Skip events containing the exclusion tag.
    if (CONFIG.EXCLUDE_TAG && (
      title.includes(CONFIG.EXCLUDE_TAG) || desc.includes(CONFIG.EXCLUDE_TAG)
    )) continue;

    // Resolve event times (all-day events have only a date, not a dateTime).
    const s = evt.start.dateTime
      ? new Date(evt.start.dateTime)
      : new Date(`${evt.start.date}T00:00:00${offset}`);
    const e = evt.end.dateTime
      ? new Date(evt.end.dateTime)
      : new Date(`${evt.end.date}T00:00:00${offset}`);

    // Clip the event to the measurement window.
    const clippedStart = Math.max(s.getTime(), winStart.getTime());
    const clippedEnd   = Math.min(e.getTime(), winEnd.getTime());
    if (clippedEnd <= clippedStart) continue;

    intervals.push([clippedStart, clippedEnd]);
  }

  if (!intervals.length) return 0;

  // Merge overlapping intervals to avoid double-counting.
  intervals.sort((a, b) => a[0] - b[0]);

  let [curS, curE] = intervals[0];
  let totalMs = 0;

  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= curE) {
      // Overlapping or adjacent — extend the current interval.
      curE = Math.max(curE, e);
    } else {
      // Gap found — record the previous interval and start a new one.
      totalMs += curE - curS;
      curS = s;
      curE = e;
    }
  }
  totalMs += curE - curS;

  return Math.round(totalMs / 60000);
}

// ---------------------------------------------------------------------------
// CAL.COM API — schedule read & write
// ---------------------------------------------------------------------------

/**
 * Fetches a Cal.com schedule via GET /v2/schedules/{id} or /v2/schedules/default.
 *
 * @param {string}      apiKey        - Cal.com API key.
 * @param {string}      apiVersion    - Value for the "cal-api-version" header.
 * @param {string|null} scheduleIdOrNull - Schedule ID, or null to fetch the default.
 * @returns {Object} The schedule object from the Cal.com response.
 * @throws {Error} If the HTTP request fails or the response is malformed.
 */
function getCalSchedule_(apiKey, apiVersion, scheduleIdOrNull) {
  const base = 'https://api.cal.com/v2';
  const headers = {
    Authorization:    'Bearer ' + apiKey,
    'cal-api-version': apiVersion,
    'Content-Type':   'application/json',
  };

  const url = scheduleIdOrNull
    ? `${base}/schedules/${encodeURIComponent(scheduleIdOrNull)}`
    : `${base}/schedules/default`;

  const res  = UrlFetchApp.fetch(url, { method: 'get', headers, muteHttpExceptions: true });
  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code >= 300) throw new Error(`Cal.com GET schedule failed (${code}): ${text}`);

  const json = JSON.parse(text);
  if (!json.data) throw new Error('Unexpected Cal.com response (missing "data" field).');

  return json.data;
}

/**
 * Updates a Cal.com schedule via PATCH /v2/schedules/{id}.
 *
 * @param {string} apiKey     - Cal.com API key.
 * @param {string} apiVersion - Value for the "cal-api-version" header.
 * @param {number} scheduleId - Numeric ID of the schedule to update.
 * @param {Object} bodyObj    - Full schedule payload (name, timeZone, availability, overrides…).
 * @returns {Object} Parsed JSON response from Cal.com.
 * @throws {Error} If the HTTP request fails.
 */
function patchCalSchedule_(apiKey, apiVersion, scheduleId, bodyObj) {
  const base = 'https://api.cal.com/v2';
  const headers = {
    Authorization:    'Bearer ' + apiKey,
    'cal-api-version': apiVersion,
    'Content-Type':   'application/json',
  };

  const res = UrlFetchApp.fetch(
    `${base}/schedules/${encodeURIComponent(scheduleId)}`,
    {
      method:            'patch',
      headers,
      payload:           JSON.stringify(bodyObj),
      muteHttpExceptions: true,
    }
  );

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code >= 300) throw new Error(`Cal.com PATCH schedule failed (${code}): ${text}`);

  return JSON.parse(text);
}

/**
 * Parses the availability array from a Cal.com schedule and returns the set
 * of ISO weekday numbers (1 = Monday … 7 = Sunday) that have availability
 * configured.
 *
 * @param {Array<{days: string[]}>} availabilityArr - The "availability" field of a Cal.com schedule.
 * @returns {Set<number>} ISO weekday numbers with at least one availability slot.
 */
function getAvailableIsoWeekdaysFromCal_(availabilityArr) {
  // Cal.com uses English weekday names; map them to ISO numbers.
  const dayNameToIso = {
    Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
    Friday: 5, Saturday: 6, Sunday: 7,
  };

  const set = new Set();
  (availabilityArr || []).forEach(block => {
    (block.days || []).forEach(dayName => {
      const iso = dayNameToIso[dayName];
      if (iso) set.add(iso);
    });
  });

  return set;
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Retrieves a required Script Property, throwing a descriptive error if missing.
 *
 * @param {GoogleAppsScript.Properties.Properties} props - Script properties object.
 * @param {string} key - Property key to retrieve.
 * @returns {string} The property value.
 * @throws {Error} If the property is not set.
 */
function mustGetProp_(props, key) {
  const v = props.getProperty(key);
  if (!v) throw new Error(`Script Property "${key}" is required but not set.`);
  return v;
}

/**
 * Returns a Date object representing midnight (00:00:00) of the given date
 * in the specified timezone.
 *
 * @param {Date}   d  - Any moment within the target day.
 * @param {string} tz - IANA timezone string.
 * @returns {Date}
 */
function startOfDayTz_(d, tz) {
  const s   = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  const off = Utilities.formatDate(d, tz, 'XXX');
  return new Date(`${s}T00:00:00${off}`);
}

/**
 * Returns the ISO weekday number (1 = Monday, 7 = Sunday) of the given date
 * in the specified timezone.
 *
 * @param {Date}   d  - Input date.
 * @param {string} tz - IANA timezone string.
 * @returns {number} Integer between 1 and 7.
 */
function isoWeekday_(d, tz) {
  return parseInt(Utilities.formatDate(d, tz, 'u'), 10);
}

/**
 * Zero-pads a number to two digits (e.g., 9 → "09").
 *
 * @param {number} n - Non-negative integer.
 * @returns {string}
 */
function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

// ---------------------------------------------------------------------------
// MANUAL TEST HELPER
// ---------------------------------------------------------------------------

/**
 * Runs everyMorning() with DRY_RUN forced to true.
 * Use this from the Apps Script editor to preview which dates would be blocked
 * without actually writing anything to Cal.com.
 */
function previewDryRun() {
  CONFIG.DRY_RUN = true;
  everyMorning();
}
