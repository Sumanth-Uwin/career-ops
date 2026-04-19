#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import os from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const defaultOptions = {
  sites: ['indeed', 'linkedin'],
  resultsWanted: 60,
  hoursOld: 168,
  location: 'Canada',
  countryIndeed: 'Canada',
  remoteOnly: false,
  maxTerms: 6,
};

function parseArgs(argv) {
  const opts = { ...defaultOptions };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sites') opts.sites = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--location') opts.location = argv[++i];
    else if (arg === '--country') opts.countryIndeed = argv[++i];
    else if (arg === '--results') opts.resultsWanted = Number(argv[++i]) || opts.resultsWanted;
    else if (arg === '--hours-old') opts.hoursOld = Number(argv[++i]) || opts.hoursOld;
    else if (arg === '--remote') opts.remoteOnly = true;
    else if (arg === '--terms') opts.terms = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`jobspy scan

Usage:
  node scan-jobspy.mjs [--terms "frontend developer,backend developer"] [--sites indeed,linkedin,glassdoor]
                       [--location Canada] [--country Canada] [--results 60] [--hours-old 168] [--remote]

Defaults:
  terms: inferred from config/profile.yml target roles
  sites: indeed,linkedin
  location: Canada
  country: Canada
`);
}

function parseQuotedListBlock(text, blockName) {
  const start = text.indexOf(`${blockName}:`);
  if (start === -1) return [];
  const lines = text.slice(start).split(/\r?\n/).slice(1);
  const values = [];
  for (const line of lines) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s*-\s*"([^"]+)"/);
    if (match) values.push(match[1]);
  }
  return values;
}

function parsePrimaryRoles(profileText) {
  const targetStart = profileText.indexOf('target_roles:');
  if (targetStart === -1) return [];
  const targetChunk = profileText.slice(targetStart);
  const primaryStart = targetChunk.indexOf('primary:');
  if (primaryStart === -1) return [];
  const lines = targetChunk.slice(primaryStart).split(/\r?\n/).slice(1);
  const values = [];
  for (const line of lines) {
    if (/^\s{2}\w/.test(line) && !line.trim().startsWith('-')) break;
    const match = line.match(/^\s*-\s*"([^"]+)"/);
    if (match) values.push(match[1]);
  }
  return values;
}

function parseSimpleList(text, key) {
  const marker = `${key}:`;
  const start = text.indexOf(marker);
  if (start === -1) return [];
  const lines = text.slice(start).split(/\r?\n/).slice(1);
  const values = [];
  for (const line of lines) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s*-\s*"([^"]+)"/);
    if (match) values.push(match[1]);
  }
  return values;
}

function titleFilterFromPortals(text) {
  const lines = text.split(/\r?\n/);
  const out = { positive: [], negative: [] };
  let section = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'positive:') section = 'positive';
    else if (trimmed === 'negative:') section = 'negative';
    else if (/^\w/.test(trimmed) && !trimmed.endsWith(':')) section = null;
    else if (section) {
      const match = line.match(/^\s*-\s*"([^"]+)"/);
      if (match) out[section].push(match[1]);
    }
  }
  return out;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'term';
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseScanHistory() {
  const file = join(projectRoot, 'data', 'scan-history.tsv');
  if (!existsSync(file)) return new Set();
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/).slice(1).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const [url] = line.split('\t');
    if (url) seen.add(url.trim());
  }
  return seen;
}

function parsePipelineUrls() {
  const file = join(projectRoot, 'data', 'pipeline.md');
  if (!existsSync(file)) return new Set();
  const matches = readFileSync(file, 'utf-8').match(/- \[.\] (https?:\/\/\S+)/g) ?? [];
  const seen = new Set();
  for (const match of matches) {
    const url = match.replace(/^- \[.\]\s+/, '').split(' | ')[0].trim();
    seen.add(url);
  }
  return seen;
}

function parseApplications() {
  const file = existsSync(join(projectRoot, 'data', 'applications.md'))
    ? join(projectRoot, 'data', 'applications.md')
    : join(projectRoot, 'applications.md');
  const seen = new Set();
  if (!existsSync(file)) return seen;
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/).filter((line) => line.startsWith('|'));
  for (const line of lines) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length >= 5 && cells[2] !== 'Date' && cells[3] && cells[4]) {
      seen.add(`${cells[3].toLowerCase()}::${cells[4].toLowerCase()}`);
    }
  }
  return seen;
}

function inferTermsFromProfile(profileText) {
  const roles = parsePrimaryRoles(profileText);
  const terms = [];
  for (const role of roles) {
    terms.push(role.toLowerCase());
    if (/frontend/i.test(role)) terms.push('react developer');
    if (/backend/i.test(role)) terms.push('node.js developer', 'java developer');
    if (/full stack/i.test(role)) terms.push('full stack engineer');
    if (/software engineer/i.test(role)) terms.push('software developer');
  }
  return Array.from(new Set(terms));
}

function parseWorkPreferences(profileText) {
  return {
    countries: parseSimpleList(profileText, 'countries'),
    avoidRolesRequiring: parseSimpleList(profileText, 'avoid_roles_requiring'),
  };
}

function choosePython() {
  const venvPython = process.platform === 'win32'
    ? join(projectRoot, 'extractors', 'jobspy', '.venv', 'Scripts', 'python.exe')
    : join(projectRoot, 'extractors', 'jobspy', '.venv', 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  return process.env.PYTHON_PATH || 'python';
}

function extractCompany(row) {
  return normalizeWhitespace(row.company || row.employer_name || row.company_name || 'Unknown');
}

function extractTitle(row) {
  return normalizeWhitespace(row.title || row.job_title || 'Untitled role');
}

function extractUrl(row) {
  return normalizeWhitespace(row.job_url || row.url || row.job_url_direct || '');
}

function extractDescription(row) {
  return normalizeWhitespace(row.description || row.job_description || '');
}

function extractLocation(row) {
  return normalizeWhitespace(row.location || row.city || '');
}

function titleMatchesFilter(title, filter) {
  const lowered = title.toLowerCase();
  const positive = filter.positive.some((term) => lowered.includes(term.toLowerCase()));
  const negative = filter.negative.some((term) => lowered.includes(term.toLowerCase()));
  return positive && !negative;
}

function inferJobUrlHostScore(url) {
  const lowered = url.toLowerCase();
  if (lowered.includes('linkedin.com/jobs/view')) return 3;
  if (lowered.includes('indeed.com/viewjob') || lowered.includes('ca.indeed.com/viewjob')) return 2;
  if (lowered.includes('glassdoor')) return 1;
  return 0;
}

function dedupeRows(rows) {
  const bestByUrl = new Map();
  for (const row of rows) {
    const url = extractUrl(row);
    if (!url) continue;
    const score = inferJobUrlHostScore(url);
    const prev = bestByUrl.get(url);
    if (!prev || score > prev._sourceScore) {
      bestByUrl.set(url, { ...row, _sourceScore: score });
    }
  }
  return [...bestByUrl.values()];
}

const WORK_AUTH_BLOCK_PATTERNS = [
  /canadian citizen/i,
  /citizenship required/i,
  /citizen[s]?\s+only/i,
  /permanent resident[s]?\s+only/i,
  /\bpr only\b/i,
  /must already hold pr/i,
  /must be eligible for reliability clearance/i,
  /must be eligible for secret clearance/i,
  /security clearance required/i,
  /no temporary resident/i,
  /temporary residents? are not eligible/i,
  /must be legally entitled to work in canada without restriction/i,
];

const REMOTE_PATTERNS = [
  /\bremote\b/i,
  /work from home/i,
];

function looksCanadaEligibleLocation(location, targetCountries) {
  const lowered = location.toLowerCase();
  if (!lowered) return true;
  if (targetCountries.some((country) => lowered.includes(country.toLowerCase()))) return true;
  if (REMOTE_PATTERNS.some((pattern) => pattern.test(location))) return true;
  const canadaCities = ['toronto', 'ottawa', 'vancouver', 'montreal', 'calgary', 'kanata', 'waterloo', 'edmonton', 'halifax', 'victoria', 'quebec'];
  return canadaCities.some((city) => lowered.includes(city));
}

function hasWorkAuthorizationBlock(text, customPhrases) {
  const lowered = text.toLowerCase();
  if (customPhrases.some((phrase) => lowered.includes(phrase.toLowerCase()))) return true;
  return WORK_AUTH_BLOCK_PATTERNS.some((pattern) => pattern.test(text));
}

const EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

async function checkUrlLiveness(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = response?.status() ?? 0;
    if (status === 404 || status === 410) {
      return { result: 'expired', reason: `HTTP ${status}` };
    }

    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    for (const pattern of EXPIRED_URL_PATTERNS) {
      if (pattern.test(finalUrl)) {
        return { result: 'expired', reason: `redirect to ${finalUrl}` };
      }
    }

    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    if (APPLY_PATTERNS.some((pattern) => pattern.test(bodyText))) {
      return { result: 'active', reason: 'apply button detected' };
    }
    for (const pattern of EXPIRED_PATTERNS) {
      if (pattern.test(bodyText)) {
        return { result: 'expired', reason: `pattern matched: ${pattern.source}` };
      }
    }
    if (bodyText.trim().length < MIN_CONTENT_CHARS) {
      return { result: 'expired', reason: 'insufficient content' };
    }
    return { result: 'uncertain', reason: 'content present but no apply button found' };
  } catch (err) {
    return { result: 'expired', reason: `navigation error: ${err.message.split('\n')[0]}` };
  }
}

async function verifyLiveness(jobs) {
  if (!jobs.length) return { active: [], expired: [] };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const active = [];
  const expired = [];
  for (const job of jobs) {
    const verdict = await checkUrlLiveness(page, job.url);
    if (verdict.result === 'active') {
      active.push(job);
    } else {
      expired.push({ ...job, livenessReason: verdict.reason });
    }
  }
  await browser.close();
  return { active, expired };
}

function appendPendingJobs(jobs) {
  const pipelineFile = join(projectRoot, 'data', 'pipeline.md');
  let content = existsSync(pipelineFile) ? readFileSync(pipelineFile, 'utf-8') : '# Pipeline Inbox\n\n## Pending\n\n## Processed\n';
  const marker = '## Processed';
  const insertion = jobs.map((job) => `- [ ] ${job.url} | ${job.company} | ${job.title}`).join('\n');
  if (!insertion) return;
  if (content.includes(marker)) {
    content = content.replace(marker, `${insertion}\n\n${marker}`);
  } else {
    content = `${content.trimEnd()}\n${insertion}\n`;
  }
  writeFileSync(pipelineFile, content, 'utf-8');
}

function appendScanHistory(records) {
  const historyFile = join(projectRoot, 'data', 'scan-history.tsv');
  const header = 'url\ttitle\tdate_seen\n';
  if (!existsSync(historyFile)) writeFileSync(historyFile, header, 'utf-8');
  for (const record of records) {
    appendFileSync(historyFile, `${record.url}\t${record.title}\t${record.date}\n`, 'utf-8');
  }
}

async function runJobSpy(opts) {
  const profileText = await readFile(join(projectRoot, 'config', 'profile.yml'), 'utf-8');
  const portalsText = await readFile(join(projectRoot, 'portals.yml'), 'utf-8');
  const filter = titleFilterFromPortals(portalsText);
  const workPreferences = parseWorkPreferences(profileText);

  const terms = (opts.terms && opts.terms.length ? opts.terms : inferTermsFromProfile(profileText))
    .slice(0, opts.maxTerms);

  const locations = [opts.location];
  const tmpRoot = mkdtempSync(join(os.tmpdir(), 'career-ops-jobspy-'));
  const rows = [];
  const pythonPath = choosePython();
  const scriptPath = join(projectRoot, 'extractors', 'jobspy', 'scrape_jobs.py');

  console.log(`Running jobspy for ${terms.length} search term(s) across ${locations.length} location(s)...`);

  let runIndex = 0;
  const totalRuns = terms.length * locations.length;
  for (const term of terms) {
    for (const location of locations) {
      runIndex += 1;
      const slug = `${runIndex}_${slugify(term)}_${slugify(location)}`;
      const outputJson = join(tmpRoot, `jobspy_jobs_${slug}.json`);
      const outputCsv = join(tmpRoot, `jobspy_jobs_${slug}.csv`);

      await new Promise((resolve, reject) => {
        const child = spawn(pythonPath, [scriptPath], {
          cwd: join(projectRoot, 'extractors', 'jobspy'),
          env: {
            ...process.env,
            JOBSPY_SITES: opts.sites.join(','),
            JOBSPY_SEARCH_TERM: term,
            JOBSPY_LOCATION: location,
            JOBSPY_RESULTS_WANTED: String(opts.resultsWanted),
            JOBSPY_HOURS_OLD: String(opts.hoursOld),
            JOBSPY_COUNTRY_INDEED: opts.countryIndeed,
            JOBSPY_LINKEDIN_FETCH_DESCRIPTION: '1',
            JOBSPY_IS_REMOTE: opts.remoteOnly ? '1' : '0',
            JOBSPY_OUTPUT_JSON: outputJson,
            JOBSPY_OUTPUT_CSV: outputCsv,
            JOBSPY_TERM_INDEX: String(runIndex),
            JOBSPY_TERM_TOTAL: String(totalRuns),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          for (const line of text.split(/\r?\n/).filter(Boolean)) {
            if (line.startsWith('JOBOPS_PROGRESS ')) {
              const payload = JSON.parse(line.slice('JOBOPS_PROGRESS '.length));
              if (payload.event === 'term_start') {
                console.log(`  [${payload.termIndex}/${payload.termTotal}] ${payload.searchTerm} @ ${payload.location}`);
              } else if (payload.event === 'term_complete') {
                console.log(`    -> ${payload.jobsFoundTerm} raw jobs`);
              }
            } else {
              process.stdout.write(`${line}\n`);
            }
          }
        });

        child.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`jobspy subprocess failed for "${term}" @ "${location}" (exit ${code})`));
        });
      });

      if (existsSync(outputJson)) {
        const parsed = JSON.parse(readFileSync(outputJson, 'utf-8'));
        rows.push(...parsed);
      }
    }
  }

  rmSync(tmpRoot, { recursive: true, force: true });

  const seenUrls = parseScanHistory();
  const pipelineUrls = parsePipelineUrls();
  const appKeys = parseApplications();
  const today = new Date().toISOString().slice(0, 10);

  const deduped = dedupeRows(rows);
  const fresh = [];
  const history = [];
  let skippedGeo = 0;
  let skippedWorkAuth = 0;

  for (const row of deduped) {
    const url = extractUrl(row);
    const title = extractTitle(row);
    const company = extractCompany(row);
    const description = extractDescription(row);
    const location = extractLocation(row);
    if (!url || !titleMatchesFilter(title, filter)) continue;
    if (seenUrls.has(url) || pipelineUrls.has(url)) continue;
    if (!looksCanadaEligibleLocation(location, workPreferences.countries)) {
      skippedGeo += 1;
      continue;
    }
    if (hasWorkAuthorizationBlock(`${title}\n${description}`, workPreferences.avoidRolesRequiring)) {
      skippedWorkAuth += 1;
      continue;
    }
    const appKey = `${company.toLowerCase()}::${title.toLowerCase()}`;
    if (appKeys.has(appKey)) continue;
    fresh.push({ url, title, company, location });
    seenUrls.add(url);
  }

  const liveness = await verifyLiveness(fresh);
  for (const job of liveness.active) {
    history.push({ url: job.url, title: job.title, date: today });
  }
  if (liveness.active.length) {
    appendPendingJobs(liveness.active);
    appendScanHistory(history);
  }

  return {
    rawCount: rows.length,
    dedupedCount: deduped.length,
    skippedGeo,
    skippedWorkAuth,
    expiredCount: liveness.expired.length,
    added: liveness.active,
  };
}

async function ensureFiles() {
  await mkdir(join(projectRoot, 'data'), { recursive: true });
  const pipelineFile = join(projectRoot, 'data', 'pipeline.md');
  if (!existsSync(pipelineFile)) {
    writeFileSync(pipelineFile, '# Pipeline Inbox\n\n## Pending\n\n## Processed\n', 'utf-8');
  }
  const historyFile = join(projectRoot, 'data', 'scan-history.tsv');
  if (!existsSync(historyFile)) {
    writeFileSync(historyFile, 'url\ttitle\tdate_seen\n', 'utf-8');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const profilePath = join(projectRoot, 'config', 'profile.yml');
  const portalsPath = join(projectRoot, 'portals.yml');
  if (!existsSync(profilePath) || !existsSync(portalsPath)) {
    throw new Error('config/profile.yml and portals.yml are required before running jobspy scan.');
  }

  await ensureFiles();
  const result = await runJobSpy(opts);

  console.log(`\nJobSpy scan complete.`);
  console.log(`Raw rows: ${result.rawCount}`);
  console.log(`Unique URLs: ${result.dedupedCount}`);
  console.log(`Skipped by Canada filter: ${result.skippedGeo}`);
  console.log(`Skipped by work auth filter: ${result.skippedWorkAuth}`);
  console.log(`Expired after liveness check: ${result.expiredCount}`);
  console.log(`Added to pipeline: ${result.added.length}`);
  for (const job of result.added.slice(0, 20)) {
    console.log(`  + ${job.company} | ${job.title}`);
  }
}

main().catch((err) => {
  console.error(`scan-jobspy failed: ${err.message}`);
  process.exit(1);
});
