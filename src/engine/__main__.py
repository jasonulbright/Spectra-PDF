"""
Spectra PDF Engine - JSON-RPC 2.0 server over stdin/stdout.

Receives requests from the Tauri backend, dispatches to
the appropriate handler, and returns results.
"""

import sys
from engine.ipc import JsonRpcServer
from engine.merge import merge
from engine.split import split
from engine.rotate import rotate
from engine.delete import delete
from engine.compress import compress
from engine.grayscale import grayscale
from engine.optimize import optimize
from engine.pdfa import convert_pdfa
from engine.encrypt import encrypt, decrypt
from engine.extract_text import extract_text
from engine.metadata import get_metadata, set_metadata, strip_metadata
from engine.reversion import get_pdf_version, set_pdf_version
from engine.inspect import get_page_count, get_page_info, check_encrypted, unlock
from engine.repair import repair
from engine.rebuild import rebuild
from engine.recover import recover
from engine.check import check
from engine.outline import get_outline, set_outline
from engine.redact import redact
from engine.watermark import watermark
from engine.compare import compare_text
from engine.signatures import verify_signatures


def ping() -> dict:
    return {"status": "ok", "engine": "spectra-pdf", "version": "0.2.0"}


def main() -> None:
    server = JsonRpcServer()
    server.register("ping", ping)
    server.register("merge", merge)
    server.register("split", split)
    server.register("rotate", rotate)
    server.register("delete", delete)
    server.register("compress", compress)
    server.register("grayscale", grayscale)
    server.register("optimize", optimize)
    server.register("convert_pdfa", convert_pdfa)
    server.register("encrypt", encrypt)
    server.register("decrypt", decrypt)
    server.register("extract_text", extract_text)
    server.register("get_metadata", get_metadata)
    server.register("set_metadata", set_metadata)
    server.register("strip_metadata", strip_metadata)
    server.register("get_pdf_version", get_pdf_version)
    server.register("set_pdf_version", set_pdf_version)
    server.register("get_page_count", get_page_count)
    server.register("get_page_info", get_page_info)
    server.register("check_encrypted", check_encrypted)
    server.register("unlock", unlock)
    server.register("repair", repair)
    server.register("rebuild", rebuild)
    server.register("recover", recover)
    server.register("check", check)
    server.register("get_outline", get_outline)
    server.register("set_outline", set_outline)
    server.register("redact", redact)
    server.register("watermark", watermark)
    server.register("compare_text", compare_text)
    server.register("verify_signatures", verify_signatures)

    # Signal readiness on stderr so the Tauri backend knows we're alive
    print("engine: ready", file=sys.stderr, flush=True)

    server.run(input_stream=sys.stdin, output_stream=sys.stdout)


if __name__ == "__main__":
    main()
