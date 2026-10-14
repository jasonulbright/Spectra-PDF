"""Signs a file, appends a rebuilt file to the signed one as a revision, and
reads the verdict of each signature.

Reads one request on stdin and writes one answer on stdout, both JSON:

    {"op": "pki", "dir": DIR}
    {"op": "sign", "file": SRC, "output": OUT, "pfx": PFX, "options": {...}}
    {"op": "append", "original": SIGNED, "modified": REBUILT, "output": OUT, "ca": CA_PEM}

`append` answers `report` (the answer of `transplant_incremental`, or
`{"raised": text}`), and with an applied revision `signatures`: per
signature the engine's verdict (pyHanko with the engine's difference policy)
and `stock`, pyHanko's verdict under its own default difference policy."""

import json
import os
import sys

sys.path.insert(0, "src")
sys.path.insert(0, "tests")


def _stock_verdicts(path: str, ca: str) -> list:
    from pyhanko.keys import load_cert_from_pemder
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    context = ValidationContext(trust_roots=[load_cert_from_pemder(ca)], allow_fetching=False)
    out = []
    with open(path, "rb") as handle:
        reader = PdfFileReader(handle, strict=False)
        for embedded in reader.embedded_signatures:
            status = validate_pdf_signature(embedded, signer_validation_context=context)
            out.append({
                "intact": bool(status.intact),
                "valid": bool(status.valid),
                "bottom_line": bool(status.bottom_line),
                "modification_level": getattr(status.modification_level, "name", None),
                "docmdp_ok": status.docmdp_ok,
            })
    return out


def main() -> None:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    op = request["op"]
    if op == "pki":
        from test_pades import _build_pki

        os.makedirs(request["dir"], exist_ok=True)
        answer = _build_pki(request["dir"])
    elif op == "sign":
        from engine.signatures import sign_pdf

        sign_pdf(request["file"], request["output"], pfx_path=request["pfx"], password="pw", **request.get("options", {}))
        answer = {"signed": True}
    elif op == "append":
        from engine.incremental import transplant_incremental
        from engine.signatures import verify_signatures

        try:
            report = transplant_incremental(request["original"], request["modified"], request["output"])
        except Exception as error:  # the caller records a raise as a finding
            report = {"raised": f"{type(error).__name__}: {error}"}
        answer = {"report": report}
        if report.get("applied"):
            verdicts = verify_signatures(request["output"], trust_roots=[request["ca"]])["signatures"]
            stock = _stock_verdicts(request["output"], request["ca"])
            keys = ("intact", "valid", "trusted", "modification_level", "policy_ok", "policy_judged")
            answer["signatures"] = [
                {**{key: verdict.get(key) for key in keys}, "stock": stock[index] if index < len(stock) else None}
                for index, verdict in enumerate(verdicts)
            ]
    else:
        raise SystemExit(f"unknown op {op}")
    sys.stdout.buffer.write(json.dumps(answer, default=str).encode("utf-8"))


if __name__ == "__main__":
    main()
