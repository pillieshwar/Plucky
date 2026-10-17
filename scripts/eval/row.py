"""Turn watch_eval's JSON summary (stdin) into a Markdown table row."""
import json
import sys

try:
    r = json.loads(sys.stdin.read())
    print(
        f"| {r['model']} | {r['accuracy'] * 100:.0f}% | {r['false_alarms']} | {r['missed']} "
        f"| {r['wrong_task']} | {r['errors']} | {r['avg_ms'] / 1000:.1f}s |"
    )
except (ValueError, KeyError):
    print("| (eval failed) | | | | | | |")
