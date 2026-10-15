#!/usr/bin/env python
"""Convenience launcher so you can start BioStore from the repo root.

    py run.py
    py run.py --desktop
"""
import argparse
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent / "backend"
sys.path.insert(0, str(BACKEND))

import app  # noqa: E402  (import after sys.path tweak)
import config  # noqa: E402

# The desktop shell always serves the UI on loopback. Lab sharing stays on
# `py run.py`, which still honors BIOSTORE_HOST / BIOSTORE_PORT.
DESKTOP_HOST = "127.0.0.1"
DESKTOP_PORT = 8765


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the BioStore local server.")
    parser.add_argument(
        "--desktop",
        action="store_true",
        help="Bind 127.0.0.1:8765 with the reloader off (used by the desktop shell).",
    )
    args = parser.parse_args()

    print(f"BioStore data root: {config.DATA_ROOT}", flush=True)
    if args.desktop:
        print(
            f"BioStore desktop server on http://{DESKTOP_HOST}:{DESKTOP_PORT}",
            flush=True,
        )
        app.app.run(
            host=DESKTOP_HOST,
            port=DESKTOP_PORT,
            debug=False,
            use_reloader=False,
            threaded=True,
        )
        return

    print(f"Open http://{config.HOST}:{config.PORT}", flush=True)
    app.app.run(host=config.HOST, port=config.PORT, debug=True)


if __name__ == "__main__":
    main()
