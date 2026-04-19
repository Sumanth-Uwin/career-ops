# Mode: apply-queue — Automated Job Application Queue

Process jobs exported from job-ops one at a time. For each job: verify the
posting is still live, fill the application form from `config/apply-details.txt`,
upload the pre-tailored resume PDF and cover letter, then stop for your review
before submitting.

---

## Startup

1. Read `data/job-queue.md`
2. Read `config/apply-details.txt`
3. Read `cv.md` (fallback context for unknown form questions)
4. Count jobs by status:
   - PENDING = not yet processed
   - APPLIED = already submitted
   - SKIPPED = user skipped
5. Show summary:

```
─────────────────────────────────────────────
apply-queue — Job Application Queue
─────────────────────────────────────────────
Total jobs : X
  PENDING  : X   ← will be processed
  APPLIED  : X
  SKIPPED  : X
─────────────────────────────────────────────
Starting with Job 01. Type STOP at any time to pause.
```

If no PENDING jobs → tell the user to run:
```
node orchestrator/export-queue.mjs
```
from the job-ops directory first.

---

## Per-Job Loop

Repeat for each PENDING job in queue order:

### Step 1 — Brief the user

Show:
```
════════════════════════════════════════════════════
JOB [N] of [TOTAL PENDING]: [Company] — [Role]
Score: [X]/100  |  Resume: [Resume Name]
────────────────────────────────────────────────────
Apply URL  : [url]
Resume PDF : [path] (exists: YES/NO)
Cover Letter: [path] (exists: YES/NO)
Summary    : [tailored summary if available, else first 200 chars of job description]
════════════════════════════════════════════════════
Proceed? [Y = yes] [s = skip] [STOP = pause queue]
```

Wait for user input:
- `Y` or Enter → proceed
- `s` or `skip` → mark SKIPPED, move to next job
- `STOP` → pause, tell user to run `/career-ops apply-queue` to resume

### Step 2 — Verify the posting is still active

Use Playwright:
1. `browser_navigate` to the apply URL
2. `browser_snapshot` to capture the page

Check:
- If page shows job title + description + an Apply button/form → **ACTIVE**, continue
- If page shows "This job has been filled", "No longer accepting applications", 404, or
  only a footer with no job content → **CLOSED**
  - Mark job as SKIPPED in queue with note "posting closed"
  - Notify user: "Job [N] ([Company] — [Role]) appears to be closed. Moving to next."
  - Continue to next job

### Step 3 — Map form fields

From the Playwright snapshot, identify ALL visible fields:

| Field type | Examples |
|------------|---------|
| Text (short) | Name, email, phone, city, LinkedIn URL |
| Text (long) | Cover letter, "Why this role?", "Tell us about yourself" |
| Dropdown | Work authorization, country, degree level, years of experience |
| Yes/No / Radio | "Do you require sponsorship?", "Are you willing to relocate?" |
| File upload | Resume, cover letter |
| Salary field | Expected salary, salary range — see salary rules below |
| Date | Available start date |
| Checkbox | "I agree to terms", referral source |

For each field, look up the matching key in `config/apply-details.txt`:
- Exact key match → use that value
- Keyword match (e.g. form says "Compensation expectation" → matches "Salary Expectation Answer") → use best match
- Q&A match → scan the Q: blocks for semantic similarity, use that A:
- No match found → generate an answer from `cv.md` + job summary, flag it as **[GENERATED - review before submit]**

**Salary field rules (in priority order):**
1. If the job posting lists a salary range → use that range as-is for min/max fields
2. If the posting lists only one number → use it for both min and max
3. If the posting has no salary → fall back to `Desired Salary Min` from apply-details.txt
   for any "minimum expected" field, and `Desired Salary Max` for any "maximum expected" field
4. `Desired Salary` = `Desired Salary Min` (the floor you will accept)
5. Update `Salary Expectation Answer` to reflect the actual range used before filling

File upload fields:
- Resume → use the Resume PDF path from job-queue.md
- Cover letter → use the Cover Letter path from job-queue.md
- If file does not exist → warn user, ask: "Resume PDF not found at [path]. Proceed without uploading, or paste the correct path?"

### Step 4 — Fill the form

Fill all identified fields via Playwright. After filling:
1. Take a `browser_snapshot` to capture the filled state
2. Scroll through the full form to check for any missed fields or multi-page navigation
3. If there are more pages/steps (wizard-style form) → fill each page, snapshot after each

### Step 5 — Review before submit

Show a structured summary:

```
────────────────────────────────────────────────────────────
REVIEW: [Company] — [Role]
────────────────────────────────────────────────────────────
PERSONAL
  Full Name     : [value]
  Email         : [value]
  Phone         : [value]
  Location      : [value]
  LinkedIn      : [value]

WORK AUTH
  Authorized    : [value]
  Sponsorship   : [value]

COMPENSATION
  Expected      : [value]

FILES
  Resume        : [filename] ✓ / ✗ not uploaded
  Cover Letter  : [filename] ✓ / ✗ not uploaded

ESSAY ANSWERS
  [Question 1]
  → [Answer filled — first 120 chars...]

  [Question 2]
  → [Answer filled — first 120 chars...]

⚠  GENERATED (needs your review):
  [Question] → [Generated answer]

────────────────────────────────────────────────────────────
SUBMIT? [Y = submit]  [n = skip this job]  [e = edit a field]
```

Wait for input:
- `Y` → proceed to Step 6 (submit)
- `n` → mark SKIPPED, log reason "user skipped at review", next job
- `e [field name]` → prompt for new value, update field in browser, re-show summary
  - Example: `e Email` → "New value for Email:" → fill, re-show summary

### Step 6 — Submit

1. Click the Submit / Apply / Send Application button via Playwright
2. Take a screenshot of the confirmation page
3. Confirm submission succeeded:
   - Look for: "Application submitted", "Thank you for applying", confirmation email notice
   - If error → do NOT mark as APPLIED, show error to user, ask how to proceed

### Step 7 — Post-application logging

After successful submission:

1. **Mark job in queue** — edit `data/job-queue.md`, update the job's status cell:
   - Change `PENDING` → `APPLIED [YYYY-MM-DD]`

2. **Update career-ops tracker** — write TSV to `batch/tracker-additions/`:
   ```
   {num}\t{date}\t{company}\t{role}\tApplied\t-\t❌\t-\tApplied via apply-queue from job-ops (score: {X}/100)
   ```

3. **Learn new Q&As** — if any GENERATED answers were used, append them to
   `config/apply-details.txt` under the `# LEARNED Q&A` section:
   ```
   Q: [exact question text from the form]
   A: [the answer that was submitted]
   # Source: [Company] [Role] — [date]
   ```

4. Show:
   ```
   ✓ Applied to [Company] — [Role]
   Tracker updated. New Q&As saved to apply-details.txt.
   
   Ready for next job? [Y = continue] [STOP = pause]
   ```

---

## Editing apply-details.txt mid-queue

If the user says "update my phone number" or "change my salary answer" at any point:
- Edit `config/apply-details.txt` directly with the new value
- Confirm: "Updated. This will be used for all remaining jobs in the queue."

---

## Resume PDF or Cover Letter missing

If the PDF does not exist at the path in job-queue.md:
- **Resume missing**: Hard stop. Tell user:
  > "Resume PDF not found: [path]. This likely means job-ops hasn't compiled the PDF yet.
  > In job-ops, open the job and click 'Generate PDF', then re-run the export:
  > `node orchestrator/export-queue.mjs`"

- **Cover letter missing**: Soft warn. Ask:
  > "Cover letter PDF not found: [path]. Do you want to:
  > 1. Skip uploading cover letter for this job
  > 2. Generate one now (I'll draft it from cv.md)
  > 3. Skip this job entirely"

---

## Pausing and resuming

- The queue state is saved in `data/job-queue.md` (PENDING / APPLIED / SKIPPED)
- To resume after pausing, just run `/career-ops apply-queue` again
- Already-processed jobs (APPLIED / SKIPPED) are skipped automatically

---

## Queue complete

When all PENDING jobs are processed:
```
════════════════════════════════════════════════════
Queue complete!
  Applied : X jobs
  Skipped : X jobs
════════════════════════════════════════════════════
New Q&As learned: X (saved to config/apply-details.txt)

Next steps:
  - Run `node orchestrator/export-queue.mjs` tomorrow for fresh jobs
  - Run `/career-ops tracker` to see your full application status
  - Review new Q&As in config/apply-details.txt and improve answers
```
