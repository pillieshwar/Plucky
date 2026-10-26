"""Summarise one watch_eval run.

Usage: row.py <eval output> <summary file>

Writes a Markdown table to the summary file and prints two GitHub notices:
the scores, and the cases the model got wrong (so they can be read from the
run's annotations).
"""
import json
import sys

lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
try:
    r = json.loads(lines[-1])
except (ValueError, IndexError):
    print("::error title=eval::no summary from watch_eval")
    sys.exit(1)

score = (
    f"accuracy {r['accuracy'] * 100:.0f}% of {r['cases']} · false alarms {r['false_alarms']} · "
    f"missed {r['missed']} · wrong task {r['wrong_task']} · errors {r['errors']} · "
    f"avg {r['avg_ms'] / 1000:.1f}s"
)
print(f"::notice title={r['model']}::{score}")

bad = [l.strip() for l in lines[:-1] if any(k in l for k in ("FALSE ALARM", "MISSED", "WRONG TASK", "ERROR"))]
if bad:
    # Annotations are one line: join with " | " and keep it short.
    print(f"::notice title={r['model']} misses::" + " | ".join(bad)[:900])

with open(sys.argv[2], "a", encoding="utf-8") as f:
    f.write(f"## {r['model']}\n\n{score}\n\n")
    if bad:
        f.write("Wrong answers:\n\n" + "\n".join(f"- {b}" for b in bad) + "\n")
