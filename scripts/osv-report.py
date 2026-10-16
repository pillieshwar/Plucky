#!/usr/bin/env python3
"""Turn OSV-Scanner's JSON report into GitHub annotations.

Fails (exit 1) on vulnerabilities. RustSec "informational" advisories such as
"unmaintained" are reported as warnings: cargo-deny decides those (see
deny.toml). Ignored IDs live in osv-scanner.toml.
"""

import json
import sys


def main(path: str) -> int:
    try:
        with open(path) as f:
            report = json.load(f)
    except FileNotFoundError:
        print(f"::error::{path} was not written; OSV-Scanner failed to run")
        return 1

    failures = 0
    warnings = 0
    for result in report.get("results", []):
        lockfile = result.get("source", {}).get("path", "?").split("/")[-1]
        for pkg in result.get("packages", []):
            name = pkg.get("package", {}).get("name", "?")
            version = pkg.get("package", {}).get("version", "?")
            for vuln in pkg.get("vulnerabilities", []):
                vid = vuln.get("id", "?")
                summary = (vuln.get("summary") or vuln.get("details") or "").splitlines()[0][:200]
                informational = (vuln.get("database_specific") or {}).get("informational")
                where = f"{name} {version} ({lockfile})"
                if informational:
                    warnings += 1
                    print(f"::warning title={vid} ({informational})::{where}: {summary}")
                else:
                    failures += 1
                    print(f"::error title={vid}::{where}: {summary}")

    print(f"OSV: {failures} vulnerabilities, {warnings} informational notices")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "osv-results.json"))
