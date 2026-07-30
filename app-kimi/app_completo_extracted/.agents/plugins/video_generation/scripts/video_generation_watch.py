#!/usr/bin/env python3
"""Watch a background video generation log until it succeeds or fails."""

from __future__ import annotations

import argparse
from datetime import datetime
import re
import sys
import time
from pathlib import Path

SUCCESS_RE = re.compile(r"Saved generated video to:\s*(.+)")
FAILURE_MARKERS = (
    "Error generating video:",
    "generate_video returned no media URL",
    "failed to download generated video from",
    "Error uploading ",
    "Traceback (most recent call last):",
)


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise SystemExit(f"failed to read log file {path}: {exc}") from exc


def _inspect_log(text: str) -> tuple[str, str | None]:
    for line in reversed(text.splitlines()):
        match = SUCCESS_RE.search(line)
        if match:
            return "done", match.group(1).strip()

    for marker in FAILURE_MARKERS:
        for line in reversed(text.splitlines()):
            if marker in line:
                return "failed", line.strip()

    return "pending", None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-file", required=True, help="Path to the generation log file")
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=60,
        help="How often to check the log again; default 60 (1 minute)",
    )
    args = parser.parse_args()

    log_file = Path(args.log_file)
    interval = max(1, args.interval_seconds)

    while True:
        text = _read_text(log_file)
        status, payload = _inspect_log(text)

        if status == "done":
            print(f"done: {payload}")
            return 0
        if status == "failed":
            print(f"failed: {payload}", file=sys.stderr)
            return 1

        checked_at = datetime.now().astimezone().isoformat(timespec="seconds")
        print(
            f"[{checked_at}] pending: {log_file} "
            f"(checking again in {interval} seconds)",
            flush=True,
        )
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
