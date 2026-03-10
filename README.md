# Google Calendar → Cal.com Auto-Blocker

Automatically blocks your Cal.com availability on days when your Google Calendar is heavily booked, using Date Overrides via the Cal.com API.

> **Created with the assistance of [ChatGPT](https://openai.com/chatgpt) and [Claude](https://claude.ai).**

---

## How It Works

1. The script reads your Cal.com schedule to find which weekdays have availability configured.
2. For each upcoming day (within the configured look-ahead window), it fetches events from your Google Calendar.
3. It sums the **confirmed busy minutes** within a configurable daily time window (e.g., 09:00–18:00), merging overlapping events to avoid double-counting.
4. If busy minutes reach the threshold (e.g., 3 hours), that date is added to Cal.com as a **Date Override** marking the full day as unavailable.
5. Existing overrides are preserved; only new dates are appended.
6. A single PATCH request updates the schedule on Cal.com.

Events are excluded from the busy-time calculation when:
- Their status is not `confirmed` (e.g., cancelled or tentative)
- They are marked as **Free** (`transparency: transparent`) in Google Calendar
- Their title or description contains the exclusion tag (e.g., `#noquota`)

---

## Prerequisites

- A **Google account** with Google Calendar
- A **Cal.com** account (free or paid)
- Access to **Google Apps Script** (free, included with any Google account)

---

## Step-by-Step Setup

### 1. Get Your Cal.com API Key

1. Log into [Cal.com](https://cal.com) and go to **Settings → Developer → API Keys**.
2. Click **Add** to create a new API key.
3. Give it a descriptive label (e.g., `apps-script-blocker`) and set an expiration date (or leave it as non-expiring).
4. Copy the generated key — it starts with `cal_live_…`. **You will not be able to see it again.**

### 2. Get Your Cal.com Schedule ID (optional)

If you want to target a **specific schedule** (not your default one):

1. Go to **Settings → Availability** in Cal.com.
2. Open the schedule you want to block.
3. The URL will look like `https://app.cal.com/availability/123456`. The number at the end is your Schedule ID.

If you omit this, the script will automatically use your **default schedule**.

### 3. Find Your Google Calendar ID

1. Open [Google Calendar](https://calendar.google.com).
2. In the left sidebar, hover over the calendar you want to use and click the three-dot menu → **Settings and sharing**.
3. Scroll down to **Integrate calendar**.
4. Copy the **Calendar ID** — it looks like `yourname@gmail.com` for the primary calendar, or a long string like `abc123def456@group.calendar.google.com` for other calendars.

### 4. Create the Google Apps Script Project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Delete any existing code in the editor.
3. Copy the entire contents of `Code.gs` from this repository and paste it into the editor.
4. Click the floppy disk icon (or press `Ctrl+S` / `Cmd+S`) to save. Give the project a name.

### 5. Enable the Google Calendar Advanced Service

The script uses the **Google Calendar API** advanced service (not the built-in `CalendarApp`), which provides access to pagination and additional event fields.

1. In the Apps Script editor, click **Services** (the `+` icon in the left sidebar).
2. Scroll down and select **Google Calendar API**.
3. Click **Add**.

> **Note:** Do not confuse this with the built-in `CalendarApp` — it is a separate service that must be explicitly enabled.

### 6. Set Script Properties

Script Properties are the secure way to store credentials and configuration in Apps Script — never hardcode API keys in the script itself.

1. In the Apps Script editor, click the gear icon (**Project Settings**) in the left sidebar.
2. Scroll down to **Script Properties** and click **Edit script properties**.
3. Add the following properties:

| Property | Required | Description |
|---|---|---|
| `CALENDAR_ID` | **Yes** | Google Calendar ID from Step 3 |
| `CAL` | **Yes** | Cal.com API key from Step 1 |
| `CAL_SCHEDULE_ID` | No | Cal.com Schedule ID from Step 2. Omit to use the default schedule. |
| `CAL_API_VERSION` | No | Cal.com API version header. Defaults to `2024-06-11`. |

4. Click **Save script properties**.

### 7. Adjust the Configuration

Open `Code.gs` and edit the `CONFIG` object at the top of the file to match your needs:

```javascript
const CONFIG = {
  // IANA timezone for all date/time calculations
  TIMEZONE: 'America/Sao_Paulo',

  // Number of upcoming days to inspect
  DAYS_AHEAD: 14,

  // Time window within which busy minutes are counted
  WINDOW_START: { hour: 9, minute: 0 },
  WINDOW_END:   { hour: 18, minute: 0 },

  // Block the day if busy minutes reach this value (180 = 3 hours)
  THRESHOLD_MINUTES: 180,

  // Events with this tag in title or description are ignored; set to '' to disable
  EXCLUDE_TAG: '#noquota',

  // When true, logs what would happen but does NOT write to Cal.com
  DRY_RUN: false,
};
```

**Common timezone values:**

| Location | Timezone string |
|---|---|
| São Paulo, Brazil | `America/Sao_Paulo` |
| New York, USA | `America/New_York` |
| Los Angeles, USA | `America/Los_Angeles` |
| London, UK | `Europe/London` |
| Paris, France | `Europe/Paris` |
| Tokyo, Japan | `Asia/Tokyo` |

For a full list, see the [IANA Time Zone Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

### 8. Authorize the Script (Required One-Time Step)

Before the automatic trigger can run on your behalf, Google requires you to explicitly grant the script permission to access your Google Calendar and make outbound HTTP requests. **This authorization must be completed manually at least once — without it, the trigger will never execute.**

1. In the Apps Script editor, select the function **`previewDryRun`** from the function dropdown at the top.
2. Click **Run**.
3. A dialog will appear saying *"Authorization required"* — click **Review permissions**.
4. Choose the Google account that owns the calendar you want to use.
5. You may see a warning screen saying *"Google hasn't verified this app"*. Click **Advanced → Go to [your project name] (unsafe)**. This is expected for personal scripts that haven't been submitted for Google verification.
6. Review the permissions requested (read access to Google Calendar and the ability to connect to external services) and click **Allow**.

The script is now authorized. This step only needs to be done once — re-authorization is only required if you revoke access or transfer the script to a different account.

### 9. Test with a Dry Run

With the script authorized, verify it produces the expected results before enabling the daily trigger:

1. The `previewDryRun` function you just ran already executed a dry run. Open **Execution log** (bottom panel) or go to **View → Logs** to see which dates would have been blocked.
2. To run it again at any time, select `previewDryRun` in the function dropdown and click **Run**. No changes are made to Cal.com during a dry run.

### 10. Set Up the Daily Trigger

Once you're happy with the dry run results:

1. In the Apps Script editor, click the clock icon (**Triggers**) in the left sidebar.
2. Click **+ Add Trigger** (bottom-right corner).
3. Configure the trigger:
   - **Function to run:** `everyMorning`
   - **Event source:** Time-driven
   - **Type of time-based trigger:** Day timer
   - **Time of day:** Choose a time before your workday starts (e.g., 6–7 AM)
4. Click **Save**.

> **Important:** The trigger runs under the account that authorized the script in Step 8. If you need to change the authorized account, go to **myaccount.google.com/permissions**, revoke access for the script, and re-run Step 8 with the correct account.

The script will now run automatically every day, blocking Cal.com availability whenever your Google Calendar is sufficiently booked.

---

## How Date Overrides Work in Cal.com

When the script sets a Date Override with `startTime: "00:00"` and `endTime: "00:00"`, Cal.com interprets this as **fully unavailable for that date**. Existing manual overrides you have set in Cal.com are never modified or removed — the script only appends new ones.

To remove a block, go to **Settings → Availability** in Cal.com, open your schedule, and delete the Date Override for that day.

---

## Excluding Events from the Calculation

You can prevent specific events from contributing to the busy-time count:

- **Mark as Free in Google Calendar:** Open the event, click **Edit**, and change the status from *Busy* to *Free*. The script ignores all transparent/free events.
- **Use the exclusion tag:** Add `#noquota` (or the value you set in `EXCLUDE_TAG`) to the event's title or description.

---

## Local Development with Clasp

[Clasp](https://github.com/google/clasp) is the Google Apps Script CLI that allows you to develop and manage Apps Script projects from your local machine.

### Set Up Clasp

1. Install Node.js and npm if you haven't already.
2. Install clasp globally:
   ```bash
   npm install -g @google/clasp
   ```

3. Clone this repository:
   ```bash
   git clone https://github.com/bwstefano/gcal-calcom-auto-blocker.git
   cd gcal-calcom-auto-blocker
   ```

4. Log in to your Google account:
   ```bash
   clasp login
   ```

5. Create an Apps Script project linked to this repository:
   - Go to [script.google.com](https://script.google.com) and create a new project
   - Copy the script ID from **Project Settings → Project ID**
   - Copy the `.clasp.json.example` file and rename it to `.clasp.json`
   - Edit `.clasp.json` and paste your Script ID:
   ```json
   {
     "scriptId": "YOUR_SCRIPT_ID_HERE",
     "projectId": "YOUR_PROJECT_ID_HERE",
     "fileExtension": "gs",
     "rootDir": "./src"
   }
   ```
   - Note: `.clasp.json` is ignored by git, so your credentials stay local.

6. Push your local code to Apps Script:
   ```bash
   clasp push
   ```

### Useful Clasp Commands

- `clasp push` — Push local code to Apps Script
- `clasp pull` — Pull code from Apps Script to local (useful if you edited online)
- `clasp logs` — View execution logs
- `clasp run` — Run a function remotely
- `clasp open` — Open the project in Apps Script editor

---

## Project Structure

```
.
├── Code.gs     # Main Google Apps Script source
└── README.md   # This file
```

---

## License

[MIT](https://opensource.org/licenses/MIT) — feel free to use, modify, and distribute.
