#!/usr/bin/env python3
"""Print cargo-deny's JSON diagnostics as GitHub annotations."""

import json
import sys


def main(path: str) -> None:
    try:
        lines = open(path).read().splitlines()
    except FileNotFoundError:
        print(f"::error::{path} missing; cargo-deny did not run")
        return
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            if line.strip():
                print(line)
            continue
        if item.get("type") != "diagnostic":
            continue
        f = item.get("fields", {})
        level = {"error": "error", "warning": "warning"}.get(f.get("severity"), "notice")
        adv = f.get("advisory") or {}
        title = adv.get("id") or f.get("code") or "cargo-deny"
        pkg = adv.get("package") or ""
        msg = f.get("message", "")
        labels = "; ".join(l.get("message", "") for l in f.get("labels", []) if l.get("message"))
        notes = " ".join(f.get("notes", []))[:400]
        text = " — ".join(x for x in [pkg, msg, labels, notes] if x)
        print(f"::{level} title={title}::{text[:900]}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "deny.json")
