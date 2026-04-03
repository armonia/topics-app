#!/usr/bin/env python3
"""AI visual review of E2E test screenshots — delegates to OpenClaw gateway."""

import json, os, sys, glob

RESULTS_DIR = os.path.join(os.environ.get("PROJECT_DIR", "."), "test-results")
OUTPUT_FILE = os.path.join(RESULTS_DIR, "ai-review.json")

def main():
    screenshots = sorted(glob.glob(os.path.join(RESULTS_DIR, "*.png")))
    if not screenshots:
        print("No screenshots found — skipping AI review")
        json.dump({"screenshots": [], "summary": {"total": 0}}, open(OUTPUT_FILE, "w"))
        return

    # Group BEFORE/AFTER pairs
    pairs = {}
    singles = []
    for img in screenshots:
        base = os.path.basename(img).replace(".png", "")
        if "-BEFORE-" in base:
            key = base.replace("-BEFORE-", "-")
            pairs.setdefault(key, {})["before"] = img
        elif "-AFTER-" in base:
            key = base.replace("-AFTER-", "-")
            pairs.setdefault(key, {})["after"] = img
        else:
            singles.append(img)

    total = len(singles) + len(pairs)
    
    # Write manifest for OpenClaw to pick up
    manifest = {
        "pairs": [{"key": k, **v} for k, v in pairs.items() if "before" in v and "after" in v],
        "singles": singles,
        "total": total,
        "status": "pending_review"
    }
    json.dump(manifest, open(OUTPUT_FILE, "w"), indent=2)
    print(f"AI Review: {total} screenshots ready for review via OpenClaw")
    print(f"  {len(pairs)} pairs + {len(singles)} singles")
    print(f"  Run: ask Jarvis to review test-results/ai-review.json")

if __name__ == "__main__":
    main()
