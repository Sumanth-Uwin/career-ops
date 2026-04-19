# JobSpy Extractor — How LinkedIn & Indeed Scraping Works

## Overview

The `jobspy` extractor scrapes job listings from **LinkedIn**, **Indeed**, and **Glassdoor** using the open-source Python library [`python-jobspy`](https://github.com/Bunsly/JobSpy). It does **not** use official APIs. Instead, it sends HTTP requests to public job search pages and parses the responses.

The extractor is a **TypeScript + Python hybrid**:

- The **TypeScript layer** (`src/run.ts`, `manifest.ts`) integrates with the orchestrator, resolves options, spawns the Python process, and maps raw output to internal job records.
- The **Python layer** (`scrape_jobs.py`) calls `python-jobspy` and writes results to JSON/CSV files on disk.

---

## File Structure

```
extractors/jobspy/
├── manifest.ts          # Registers this extractor with the orchestrator
├── src/run.ts           # TypeScript runner — spawns Python, parses output
├── scrape_jobs.py       # Python script — calls python-jobspy
└── requirements.txt     # Python dependencies: python-jobspy, pandas
```

---

## Step-by-Step Flow

### 1. Orchestrator calls the extractor

The orchestrator invokes `manifest.ts`, which calls `runJobSpy()` from `src/run.ts` with resolved options:

```typescript
// manifest.ts
const result = await runJobSpy({
  sites,                          // e.g. ["indeed", "linkedin"]
  searchTerms: context.searchTerms,
  location: context.settings.searchCities ?? context.settings.jobspyLocation,
  resultsWanted: ...,
  countryIndeed: context.settings.jobspyCountryIndeed,
  workplaceTypes: ...,
  onProgress: ...,
});
```

### 2. TypeScript resolves search matrix

`runJobSpy()` builds a **matrix of (searchTerm × location)** combinations. Each pair becomes one Python subprocess call:

```
searchTerms: ["software engineer", "backend developer"]
locations:   ["Toronto", "Vancouver"]

→ 4 runs:
  run 1: software engineer @ Toronto
  run 2: software engineer @ Vancouver
  run 3: backend developer @ Toronto
  run 4: backend developer @ Vancouver
```

Output files are named with a slug, e.g.:
`jobspy_jobs_1_software_engineer_toronto.json`

### 3. Python subprocess is spawned

For each (term, location) pair, TypeScript spawns `scrape_jobs.py` as a child process with all parameters passed via **environment variables**:

```typescript
spawn(pythonPath, ["scrape_jobs.py"], {
  env: {
    JOBSPY_SITES:                      "indeed,linkedin",
    JOBSPY_SEARCH_TERM:                "software engineer",
    JOBSPY_LOCATION:                   "Toronto",
    JOBSPY_RESULTS_WANTED:             "200",
    JOBSPY_HOURS_OLD:                  "72",
    JOBSPY_COUNTRY_INDEED:             "Canada",
    JOBSPY_LINKEDIN_FETCH_DESCRIPTION: "1",
    JOBSPY_IS_REMOTE:                  "0",
    JOBSPY_OUTPUT_CSV:                 "/path/to/output.csv",
    JOBSPY_OUTPUT_JSON:                "/path/to/output.json",
    JOBSPY_TERM_INDEX:                 "1",
    JOBSPY_TERM_TOTAL:                 "4",
  }
})
```

### 4. Python calls `python-jobspy`

`scrape_jobs.py` reads the environment variables and calls `jobspy.scrape_jobs()`:

```python
from jobspy import scrape_jobs

jobs = scrape_jobs(
    site_name=["indeed", "linkedin"],   # which boards to scrape
    search_term="software engineer",
    location="Toronto",
    results_wanted=200,
    hours_old=72,                       # only jobs posted in last N hours
    country_indeed="Canada",            # selects ca.indeed.com
    linkedin_fetch_description=True,    # fetches full job description from LinkedIn
    is_remote=False,
)
```

`python-jobspy` handles:
- Constructing the correct search URLs for each platform
- Sending HTTP requests (with browser-like headers)
- Parsing HTML / JSON responses
- Returning results as a **pandas DataFrame**

### 5. Glassdoor special handling

Glassdoor requires **city-level** location (not country-level). The script has a fallback map:

```python
GLASSDOOR_COUNTRY_TO_CITY = {
    "canada":         "Toronto",
    "united kingdom": "London",
    "united states":  "New York",
    # ...
}
```

If the user-supplied location is a country name, it maps it to a major city before calling Glassdoor. If the first city returns no results, it falls back through a list of candidate cities.

Glassdoor is always scraped **separately** from Indeed/LinkedIn so its location override doesn't affect them.

### 6. Progress events are streamed back

The Python script prints structured progress lines to stdout:

```
JOBOPS_PROGRESS {"event": "term_start",    "termIndex": 1, "termTotal": 4, "searchTerm": "software engineer"}
JOBOPS_PROGRESS {"event": "term_complete", "termIndex": 1, "termTotal": 4, "searchTerm": "software engineer", "jobsFoundTerm": 87}
```

TypeScript reads stdout line-by-line, parses these lines, and fires `onProgress` callbacks to update the UI. All other stdout/stderr lines are forwarded to the parent process logs.

### 7. Results are written to disk then read back

The Python script writes two output files:
- `output.json` — used by TypeScript to read results
- `output.csv`  — written in parallel (same data, not consumed by the runner)

TypeScript reads the JSON file after the process exits:

```typescript
const raw = await readFile(outputJson, "utf-8");
const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
```

Both files are deleted after parsing to avoid stale data accumulating.

### 8. Raw rows are mapped to internal job records

`mapJobSpyRows()` converts each raw JSON object from python-jobspy's output into the internal `CreateJobInput` shape:

| python-jobspy field   | Internal field           |
|-----------------------|--------------------------|
| `site`                | `source`                 |
| `id`                  | `sourceJobId`            |
| `job_url`             | `jobUrl`                 |
| `job_url_direct`      | `jobUrlDirect`           |
| `title`               | `title`                  |
| `company`             | `employer`               |
| `company_url`         | `employerUrl`            |
| `location`            | `location`               |
| `description`         | `jobDescription`         |
| `date_posted`         | `datePosted`             |
| `job_type`            | `jobType`                |
| `is_remote`           | `isRemote`               |
| `min_amount`          | `salaryMinAmount`        |
| `max_amount`          | `salaryMaxAmount`        |
| `currency`            | `salaryCurrency`         |
| `interval`            | `salaryInterval`         |
| `job_level`           | `jobLevel`               |
| `skills`              | `skills`                 |
| `company_industry`    | `companyIndustry`        |
| `company_logo`        | `companyLogo`            |
| `company_description` | `companyDescription`     |
| `company_rating`      | `companyRating`          |

Salary is also formatted into a human-readable string:
`"CAD 80000-120000 / yearly"`

Duplicate job URLs (across multiple search runs) are deduplicated using a `seenJobUrls` Set before the jobs are returned.

---

## Environment Variables Reference

| Variable                          | Default              | Description                                              |
|-----------------------------------|----------------------|----------------------------------------------------------|
| `JOBSPY_SITES`                    | `indeed,linkedin`    | Comma-separated list of sites to scrape                  |
| `JOBSPY_SEARCH_TERM`              | `web developer`      | Job title / keyword to search for                        |
| `JOBSPY_LOCATION`                 | `Canada`             | Location filter (city, region, or country)               |
| `JOBSPY_RESULTS_WANTED`           | `200`                | Max number of results per (term, location, site) call    |
| `JOBSPY_HOURS_OLD`                | `72`                 | Only return jobs posted within the last N hours          |
| `JOBSPY_COUNTRY_INDEED`           | `Canada`             | Determines which Indeed regional domain is used          |
| `JOBSPY_LINKEDIN_FETCH_DESCRIPTION` | `1` (true)         | Whether to fetch full job descriptions from LinkedIn     |
| `JOBSPY_IS_REMOTE`                | `0` (false)          | Filter for remote jobs only                              |
| `JOBSPY_OUTPUT_CSV`               | `jobs.csv`           | Path for CSV output file                                 |
| `JOBSPY_OUTPUT_JSON`              | `jobs.json`          | Path for JSON output file                                |
| `JOBSPY_TERM_INDEX`               | `1`                  | Current term index (for progress reporting)              |
| `JOBSPY_TERM_TOTAL`               | `1`                  | Total number of terms (for progress reporting)           |
| `PYTHON_PATH`                     | auto-detected        | Path to Python executable (falls back to `.venv`)        |

---

## Python Environment Setup

The Python script requires a virtual environment with `python-jobspy` and `pandas` installed.

**Development (local):**
```bash
cd extractors/jobspy
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # Linux/macOS
.venv\Scripts\pip install -r requirements.txt  # Windows
```

TypeScript auto-detects the `.venv` directory. If found, it uses `.venv/bin/python3` (or `.venv/Scripts/python.exe` on Windows). Otherwise it falls back to the system `python3`.

**Docker / CI:**
Set `PYTHON_PATH=/usr/bin/python3` explicitly and install requirements in the Dockerfile.

---

## Known Limitations & Fragility

1. **No official API** — LinkedIn and Indeed do not provide a public jobs API. This scraper works by mimicking browser HTTP requests. Either platform can break the scraper at any time by changing their HTML structure or adding bot detection.

2. **Rate limiting** — Sending too many requests in a short window can trigger temporary IP bans or CAPTCHA challenges. The `results_wanted` and `hours_old` parameters control how much data is requested per run.

3. **Dependency on maintainer** — When LinkedIn/Indeed break the scraper, fixes depend on the `python-jobspy` open-source maintainers releasing a patch. Pinning a specific version in `requirements.txt` is recommended for stability; upgrading periodically picks up fixes.

4. **Glassdoor location sensitivity** — Glassdoor's search rejects country-level locations and often fails silently, returning 0 results. The fallback city-mapping logic in `scrape_jobs.py` works around this, but may need updating for new countries/regions.

5. **LinkedIn description fetching is slow** — When `JOBSPY_LINKEDIN_FETCH_DESCRIPTION=1`, the library makes an additional HTTP request per job to retrieve the full description. This can significantly increase scrape time for large result sets.

---

## Alternatives to Consider

If scraper reliability becomes a blocker, these are drop-in alternatives:

| Option                  | Type              | Notes                                              |
|-------------------------|-------------------|----------------------------------------------------|
| **JSearch (RapidAPI)**  | Paid API          | Aggregates LinkedIn, Indeed, Glassdoor via stable API |
| **Adzuna API**          | Free official API | Already implemented in `extractors/adzuna/`        |
| **Apify LinkedIn Actor**| Paid scraping SaaS| Maintained scraper, handles anti-bot measures      |
| **LinkedIn Jobs API**   | Official (gated)  | Requires LinkedIn partner approval                 |
| **Indeed Publisher API**| Official (gated)  | Largely closed to new partners                     |
