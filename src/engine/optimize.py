"""PDF optimization using pikepdf (lossless, no Ghostscript)."""

from pathlib import Path

import pikepdf

from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf


def _rebrand_xmptk(path: Path) -> None:
    """Replace pikepdf's xmptk attribute. Same byte length to preserve linearization."""
    data = path.read_bytes()
    patched = data.replace(b'xmptk="pikepdf"', b'xmptk="SpecPDF"')
    if patched != data:
        path.write_bytes(patched)


def optimize(
    file: str,
    output: str,
    linearize: bool = True,
    strip_metadata: bool = False,
    compress_streams: bool = True,
) -> dict:
    """Optimize a PDF without re-rendering.

    Args:
        file: Input PDF path (may equal `output`).
        output: Output PDF path.
        linearize: Enable web-optimized (linearized) output.
        strip_metadata: Remove all XMP and document info metadata.
        compress_streams: Use object streams for smaller output.
    """
    input_path = Path(file)
    output_path = Path(output)
    # Read the input's size before the save: in-place staging renames over the
    # output, so afterwards `input_path` IS the result.
    original_size = input_path.stat().st_size

    with pikepdf.open(file) as pdf:
        if strip_metadata:
            with pdf.open_metadata(
                set_pikepdf_as_editor=False, update_docinfo=False
            ) as meta:
                meta.clear()
            if pikepdf.Name.Info in pdf.trailer:
                del pdf.trailer[pikepdf.Name.Info]

        stream_mode = (
            pikepdf.ObjectStreamMode.generate
            if compress_streams
            else pikepdf.ObjectStreamMode.preserve
        )

        # pikepdf cannot save over its own open input (engine/inplace.py), and
        # the Compress panel's second step optimizes the file the first step
        # just wrote. The destination cannot be replaced while the Pdf still
        # holds it open.
        if is_same_file(file, output):
            with staged_write(output_path) as staged:
                save_pdf(pdf, staged, linearize=linearize, object_stream_mode=stream_mode)
                pdf.close()
        else:
            save_pdf(pdf, output_path, linearize=linearize, object_stream_mode=stream_mode)

    if strip_metadata:
        _rebrand_xmptk(output_path)

    return {
        "output": str(output_path),
        "original_size": original_size,
        "output_size": output_path.stat().st_size,
        "linearized": linearize,
        "metadata_stripped": strip_metadata,
        "streams_compressed": compress_streams,
    }
