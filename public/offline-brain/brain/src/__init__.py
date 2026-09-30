"""
The local brain: the modules that make up the offline-first system.

Import order matters nowhere in this package — every module reads its settings at
call time rather than at import time — so a caller can import exactly the piece
it needs. The two entry points worth knowing are `server.serve`, which runs the
HTTP API, and the `brain.py` file one directory up, which is the CLI.
"""

from __future__ import annotations

from .config import VERSION, PACKAGE, PROTOCOL

__all__ = ["VERSION", "PACKAGE", "PROTOCOL"]
