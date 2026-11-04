"""Startup script for embedded Python — adds engine parent to sys.path."""
import sys

# The engine tree is a payload, not a cache: set before any engine import so
# no launcher (windowed, CLI, scheduled, watched-folder, or a bare
# `python __startup__.py`) writes __pycache__ into it, whatever its environment.
#
# A launcher that names a cache directory of its own (PYTHONPYCACHEPREFIX;
# `engine::python_env` in the host points it at the per-user cache, or the
# portable root) keeps bytecode there instead, outside the payload. Every
# later start then reads the engine and its packages compiled, which is the
# difference between a seconds-long import and a sub-second one: without a
# cache, every engine process recompiles every module from source, because
# the payload ships none and this line forbids writing any.
if sys.pycache_prefix is None:
    sys.dont_write_bytecode = True

import os  # noqa: E402

# Add the directory containing the 'engine' package to sys.path
engine_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if engine_dir not in sys.path:
    sys.path.insert(0, engine_dir)

from engine.__main__ import main  # noqa: E402
main()
