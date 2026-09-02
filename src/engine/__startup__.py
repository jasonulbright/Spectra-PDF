"""Startup script for embedded Python — adds engine parent to sys.path."""
import sys

# The engine tree is a payload, not a cache: set before any engine import so
# no launcher (windowed, CLI, scheduled, watched-folder, or a bare
# `python __startup__.py`) writes __pycache__ into it, whatever its environment.
sys.dont_write_bytecode = True

import os  # noqa: E402

# Add the directory containing the 'engine' package to sys.path
engine_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if engine_dir not in sys.path:
    sys.path.insert(0, engine_dir)

from engine.__main__ import main  # noqa: E402
main()
