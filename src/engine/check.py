"""PDF structural validation (check mode).

Validates PDF structure without modifying the file. Reports xref integrity,
stream health, page tree, font embedding, encryption status. JSON output
for programmatic use.
"""

import os
import pikepdf
from pathlib import Path

from engine.font_embedding import font_embedded


def _font_label(font_obj, resource_name) -> str:
    """The name a reader can look for: the font's own /BaseFont where it has
    one, and otherwise the resource key it is reached by."""
    try:
        base = font_obj.get("/BaseFont")
        if base is not None:
            return str(base).lstrip("/")
    except Exception:
        pass
    return str(resource_name)


def _survey_fonts(pdf) -> dict:
    """Every font named by a page's resources, sorted into the three answers.

    Counted once per indirect object: a font referenced from forty pages is
    one font program, and a total that counted references would report a
    document as forty times heavier in fonts than it is.

    Nothing is truncated and nothing degrades to a pass. A font whose
    embedding will not read is held apart from both answers, and a page whose
    font resources will not read becomes an issue naming that page — a
    swallowed failure would report a document with unknown fonts as one whose
    fonts are all embedded.
    """
    embedded: list[str] = []
    not_embedded: list[str] = []
    unreadable: list[str] = []
    problems: list[dict] = []
    seen: set = set()

    for index, page in enumerate(pdf.pages):
        page_num = index + 1
        try:
            resources = page.get("/Resources")
            font_dict = None if resources is None else resources.get("/Font")
            if font_dict is None:
                continue
            names = list(font_dict.keys())
        except Exception as e:
            problems.append({
                "severity": "warning",
                "category": "fonts",
                "message": f"Page {page_num}: font resources could not be read: {e}",
            })
            continue

        for resource_name in names:
            try:
                font_obj = font_dict[resource_name]
                objgen = getattr(font_obj, "objgen", (0, 0))
                if objgen != (0, 0):
                    if objgen in seen:
                        continue
                    seen.add(objgen)
                label = _font_label(font_obj, resource_name)
                state = font_embedded(font_obj)
            except Exception as e:
                problems.append({
                    "severity": "warning",
                    "category": "fonts",
                    "message": f"Page {page_num}: font {resource_name} could not be read: {e}",
                })
                continue
            if state is True:
                embedded.append(label)
            elif state is False:
                not_embedded.append(label)
            else:
                unreadable.append(label)

    return {
        "embedded": embedded,
        "not_embedded": not_embedded,
        "unreadable": unreadable,
        "problems": problems,
    }


def check(file: str) -> dict:
    """Validate PDF structure and report findings.

    Performs a comprehensive structural check without modifying the file.
    Returns a detailed report suitable for JSON output.

    Args:
        file: Input PDF path.
    """
    input_path = Path(file)

    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    file_size = os.path.getsize(file)
    report = {
        "file": str(input_path),
        "size_bytes": file_size,
        "valid": True,
        "issues": [],
        "info": {},
    }

    # 1. Check file header (PDF magic bytes)
    with open(file, "rb") as f:
        header = f.read(1024)
        if not header.startswith(b"%PDF-"):
            report["valid"] = False
            report["issues"].append({
                "severity": "error",
                "category": "header",
                "message": "Missing PDF header (%PDF-)",
            })
            return report

        # Extract PDF version from header
        version_line = header[:20].decode("latin-1", errors="replace")
        if version_line.startswith("%PDF-"):
            report["info"]["pdf_version"] = version_line[5:].split()[0].rstrip("\r\n")

    # 2. Try opening with pikepdf (validates xref, trailer, object streams)
    try:
        pdf = pikepdf.open(file, suppress_warnings=False)
    except pikepdf.PasswordError:
        report["info"]["encrypted"] = True
        report["issues"].append({
            "severity": "info",
            "category": "encryption",
            "message": "PDF is encrypted -- cannot perform deep validation without password",
        })
        return report
    except Exception as e:
        report["valid"] = False
        report["issues"].append({
            "severity": "error",
            "category": "structure",
            "message": f"Failed to open: {e}",
        })
        return report

    with pdf:
        report["info"]["encrypted"] = False

        # 3. Page count and page tree validation
        try:
            page_count = len(pdf.pages)
            report["info"]["pages"] = page_count
        except Exception as e:
            report["valid"] = False
            report["issues"].append({
                "severity": "error",
                "category": "page_tree",
                "message": f"Cannot read page tree: {e}",
            })
            return report

        # 4. Per-page validation (MediaBox, Resources)
        page_issues = []
        for i, page in enumerate(pdf.pages):
            page_num = i + 1
            try:
                mediabox = page.get("/MediaBox")
                if mediabox is None:
                    page_issues.append({
                        "severity": "warning",
                        "category": "page",
                        "message": f"Page {page_num}: missing MediaBox",
                    })
            except Exception as e:
                page_issues.append({
                    "severity": "error",
                    "category": "page",
                    "message": f"Page {page_num}: {e}",
                })

            # Check for Resources dict
            try:
                resources = page.get("/Resources")
                if resources is None:
                    page_issues.append({
                        "severity": "warning",
                        "category": "page",
                        "message": f"Page {page_num}: missing Resources dictionary",
                    })
            except Exception:
                pass  # Not critical

        if page_issues:
            report["issues"].extend(page_issues)
            # Page issues are warnings unless MediaBox errors
            if any(p["severity"] == "error" for p in page_issues):
                report["valid"] = False

        # 5. Font embedding check
        fonts = _survey_fonts(pdf)

        report["info"]["fonts_checked"] = (
            len(fonts["embedded"])
            + len(fonts["not_embedded"])
            + len(fonts["unreadable"])
        )
        report["info"]["fonts_embedded"] = len(fonts["embedded"])
        report["info"]["fonts_not_embedded"] = len(fonts["not_embedded"])
        report["info"]["fonts_unreadable"] = len(fonts["unreadable"])
        if fonts["not_embedded"]:
            report["issues"].append({
                "severity": "warning",
                "category": "fonts",
                "message": f"{len(fonts['not_embedded'])} font(s) not embedded: {', '.join(fonts['not_embedded'][:10])}",
            })
        if fonts["unreadable"]:
            report["issues"].append({
                "severity": "warning",
                "category": "fonts",
                "message": f"{len(fonts['unreadable'])} font(s) could not be read, so whether they are embedded is unknown: {', '.join(fonts['unreadable'][:10])}",
            })
        report["issues"].extend(fonts["problems"])

        # 6. Linearization check
        report["info"]["linearized"] = pdf.is_linearized

        # 7. Summary
        errors = sum(1 for i in report["issues"] if i["severity"] == "error")
        warnings = sum(1 for i in report["issues"] if i["severity"] == "warning")
        report["summary"] = {
            "errors": errors,
            "warnings": warnings,
            "status": "ok" if errors == 0 else "damaged",
        }

    return report
