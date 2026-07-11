"""
Spectra PDF Engine - JSON-RPC 2.0 server over stdin/stdout.

Receives requests from the Tauri backend, dispatches to
the appropriate handler, and returns results.
"""

import sys

# The JSON-RPC channel is UTF-8 BY CONTRACT. On Windows an embedded Python
# defaults its stdio to the ANSI codepage (cp1252), which silently decodes the
# Rust side's UTF-8 request bytes as cp1252 — mojibake for EVERY non-ASCII
# value on every text-carrying op (metadata titles, watermark text, form
# values, bookmark titles, signer names), in the GUI and the CLI alike, and it
# corrupts VALID values, not just ones validation should reject
# (review-caught live: "José García" stored as mojibake; "日本語" sailed past
# the forms WinAnsi check as cp1252 gibberish that happened to encode).
# Reconfigure both directions before the server reads anything. The spawners
# also set PYTHONUTF8=1 (engine.rs / cli.rs) as belt-and-suspenders — this
# line is the authoritative fix that holds no matter how the engine is run.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

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
from engine.compare import compare_text, compare_visual
from engine.forms import read_form_fields, fill_form_fields
from engine.ocr_layer import apply_ocr_layer
from engine.signatures import verify_signatures, sign_pdf, generate_signer


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
    server.register("compare_visual", compare_visual)
    server.register("read_form_fields", read_form_fields)
    server.register("fill_form_fields", fill_form_fields)
    server.register("apply_ocr_layer", apply_ocr_layer)
    server.register("verify_signatures", verify_signatures)
    server.register("sign_pdf", sign_pdf)
    server.register("generate_signer", generate_signer)

    # Signal readiness on stderr so the Tauri backend knows we're alive
    print("engine: ready", file=sys.stderr, flush=True)

    server.run(input_stream=sys.stdin, output_stream=sys.stdout)


if __name__ == "__main__":
    main()
