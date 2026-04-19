#!/usr/bin/env python3

import json
import os
import sys
from pathlib import Path


def emit_progress(payload):
    print(f"JOBOPS_PROGRESS {json.dumps(payload)}", flush=True)


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


GLASSDOOR_COUNTRY_TO_CITIES = {
    "canada": ["Toronto", "Vancouver", "Ottawa", "Montreal", "Calgary"],
    "united states": ["New York", "San Francisco", "Austin"],
    "united kingdom": ["London", "Manchester"],
}


def normalized_site_names(raw_sites):
    return [site.strip().lower() for site in raw_sites.split(",") if site.strip()]


def normalize_location_for_glassdoor(location: str, country_indeed: str):
    location = (location or "").strip()
    if not location:
        return [country_indeed]

    lowered = location.lower()
    if lowered in GLASSDOOR_COUNTRY_TO_CITIES:
        return GLASSDOOR_COUNTRY_TO_CITIES[lowered]

    return [location]


def run_scrape(site_names, search_term, location, results_wanted, hours_old, country_indeed, linkedin_fetch_description, is_remote):
    from jobspy import scrape_jobs  # Imported lazily so setup errors print cleanly.

    return scrape_jobs(
        site_name=site_names,
        search_term=search_term,
        location=location,
        results_wanted=results_wanted,
        hours_old=hours_old,
        country_indeed=country_indeed,
        linkedin_fetch_description=linkedin_fetch_description,
        is_remote=is_remote,
    )


def dataframe_to_rows(df):
    if df is None:
        return []
    records = df.where(df.notna(), None).to_dict(orient="records")
    rows = []
    for row in records:
        clean = {}
        for key, value in row.items():
            if hasattr(value, "isoformat"):
                clean[key] = value.isoformat()
            else:
                clean[key] = value
        rows.append(clean)
    return rows


def main():
    output_json = Path(os.getenv("JOBSPY_OUTPUT_JSON", "jobs.json"))
    output_csv = Path(os.getenv("JOBSPY_OUTPUT_CSV", "jobs.csv"))

    sites = normalized_site_names(os.getenv("JOBSPY_SITES", "indeed,linkedin"))
    search_term = os.getenv("JOBSPY_SEARCH_TERM", "software engineer")
    location = os.getenv("JOBSPY_LOCATION", "Canada")
    results_wanted = env_int("JOBSPY_RESULTS_WANTED", 100)
    hours_old = env_int("JOBSPY_HOURS_OLD", 168)
    country_indeed = os.getenv("JOBSPY_COUNTRY_INDEED", "Canada")
    linkedin_fetch_description = env_bool("JOBSPY_LINKEDIN_FETCH_DESCRIPTION", True)
    is_remote = env_bool("JOBSPY_IS_REMOTE", False)
    term_index = env_int("JOBSPY_TERM_INDEX", 1)
    term_total = env_int("JOBSPY_TERM_TOTAL", 1)

    emit_progress({
        "event": "term_start",
        "termIndex": term_index,
        "termTotal": term_total,
        "searchTerm": search_term,
        "location": location,
        "sites": sites,
    })

    all_rows = []

    try:
        non_glassdoor_sites = [site for site in sites if site != "glassdoor"]
        if non_glassdoor_sites:
            df = run_scrape(
                site_names=non_glassdoor_sites,
                search_term=search_term,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                country_indeed=country_indeed,
                linkedin_fetch_description=linkedin_fetch_description,
                is_remote=is_remote,
            )
            all_rows.extend(dataframe_to_rows(df))

        if "glassdoor" in sites:
            glassdoor_rows = []
            for city in normalize_location_for_glassdoor(location, country_indeed):
                df = run_scrape(
                    site_names=["glassdoor"],
                    search_term=search_term,
                    location=city,
                    results_wanted=results_wanted,
                    hours_old=hours_old,
                    country_indeed=country_indeed,
                    linkedin_fetch_description=False,
                    is_remote=is_remote,
                )
                glassdoor_rows = dataframe_to_rows(df)
                if glassdoor_rows:
                    break
            all_rows.extend(glassdoor_rows)

        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_csv.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text(json.dumps(all_rows, indent=2), encoding="utf-8")

        try:
            import pandas as pd
            pd.DataFrame(all_rows).to_csv(output_csv, index=False)
        except Exception:
            output_csv.write_text("", encoding="utf-8")

        emit_progress({
            "event": "term_complete",
            "termIndex": term_index,
            "termTotal": term_total,
            "searchTerm": search_term,
            "location": location,
            "jobsFoundTerm": len(all_rows),
        })
        return 0
    except Exception as exc:
        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text("[]", encoding="utf-8")
        print(f"JOBOPS_ERROR {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
