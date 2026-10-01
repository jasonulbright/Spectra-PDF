"""The CUPS spool: IPP job options, the prepared copy, and the submission
sequence against a recording stand-in for libcups."""

import ctypes
import os

import pikepdf
import pytest

from engine import cups_print
from engine import printer as printer_mod


def _pdf(path, boxes, encrypt=False):
    pdf = pikepdf.new()
    for media, crop in boxes:
        page = pdf.add_blank_page(page_size=(media[2], media[3]))
        page.obj.MediaBox = pikepdf.Array(media)
        if crop is not None:
            page.obj.CropBox = pikepdf.Array(crop)
    if encrypt:
        pdf.save(path, encryption=pikepdf.Encryption(owner="o", user="", R=6))
    else:
        pdf.save(path)
    return path


class TestJobOptions:
    def test_defaults_send_only_scaling(self):
        assert cups_print.job_options("", "fit", "printer", None, "auto", "printer") == [
            ("print-scaling", "fit"),
        ]

    def test_every_control_maps_to_its_ipp_attribute(self):
        assert cups_print.job_options(
            "1-3,5", "actual", "long", "iso_a4_210x297mm", "landscape", "gray"
        ) == [
            ("page-ranges", "1-3,5"),
            ("print-scaling", "none"),
            ("sides", "two-sided-long-edge"),
            ("orientation-requested", "4"),
            ("print-color-mode", "monochrome"),
            ("media", "iso_a4_210x297mm"),
        ]

    def test_short_edge_simplex_portrait_and_colour(self):
        opts = dict(cups_print.job_options("", "fit", "short", None, "portrait", "color"))
        assert opts["sides"] == "two-sided-short-edge"
        assert opts["orientation-requested"] == "3"
        assert opts["print-color-mode"] == "color"
        assert dict(cups_print.job_options("", "fit", "simplex", None, "auto", "printer"))[
            "sides"
        ] == "one-sided"

    @pytest.mark.parametrize("good", ["iso_a4_210x297mm", "na_letter_8.5x11in", "Letter", "A4"])
    def test_media_keywords_are_accepted(self, good):
        assert cups_print.validate_media(good) == good

    @pytest.mark.parametrize("bad", ["", " A4", "a4;rm", "x" * 200, 9, None, "-a4"])
    def test_anything_else_is_not_a_paper(self, bad):
        with pytest.raises(ValueError, match="paper"):
            cups_print.validate_media(bad)

    def test_destination_names_split_at_the_instance(self):
        assert cups_print.split_destination("Office") == ("Office", None)
        assert cups_print.split_destination("Office/duplex") == ("Office", "duplex")
        assert cups_print.split_destination("Office/") == ("Office", None)


class TestPreparedCopy:
    def test_an_uncropped_plain_document_spools_itself(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        assert cups_print.prepare_for_spool(src, str(tmp_path)) == src

    def test_a_crop_box_becomes_the_media_box(self, tmp_path):
        src = _pdf(
            str(tmp_path / "in.pdf"),
            [([0, 0, 200, 300], [10, 20, 110, 220]), ([0, 0, 200, 300], None)],
        )
        out = cups_print.prepare_for_spool(src, str(tmp_path))
        assert out != src
        with pikepdf.open(out) as pdf:
            first, second = pdf.pages
            assert [float(v) for v in first.mediabox] == [10, 20, 110, 220]
            assert "/CropBox" not in first.obj
            assert [float(v) for v in second.mediabox] == [0, 0, 200, 300]

    def test_a_crop_box_is_clipped_to_the_media_box(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], [-50, 100, 150, 400])])
        out = cups_print.prepare_for_spool(src, str(tmp_path))
        with pikepdf.open(out) as pdf:
            assert [float(v) for v in pdf.pages[0].mediabox] == [0, 100, 150, 300]

    def test_an_encrypted_document_spools_a_plain_copy(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)], encrypt=True)
        out = cups_print.prepare_for_spool(src, str(tmp_path))
        assert out != src
        with pikepdf.open(out) as pdf:
            assert not pdf.is_encrypted


class _FakeCups:
    """Records the libcups calls a submission makes."""

    def __init__(self, saved=(), create_status=0, start_status=100, finish_status=0, found=True):
        self.calls = []
        self.added = []
        self.written = bytearray()
        self.create_status = create_status
        self.start_status = start_status
        self.finish_status = finish_status
        self.found = found
        self._keep = []
        options = (cups_print._Option * max(1, len(saved)))()
        for i, (name, value) in enumerate(saved):
            options[i].name = name.encode()
            options[i].value = value.encode()
        self._keep.append(options)
        self.dest = cups_print._Dest(
            b"Office", None, 1, len(saved), ctypes.cast(options, ctypes.POINTER(cups_print._Option))
        )

    def cupsGetNamedDest(self, http, name, instance):
        self.calls.append(("dest", name, instance))
        return ctypes.pointer(self.dest) if self.found else None

    def cupsLastError(self):
        return 0x0406

    def cupsLastErrorString(self):
        return b"not found"

    def cupsAddOption(self, name, value, num, opts):
        self.added.append((name.decode(), value.decode()))
        return num + 1

    def cupsCopyDestInfo(self, http, dest):
        return 1

    def cupsCreateDestJob(self, http, dest, info, job_id, title, num, opts):
        self.calls.append(("create", title, num))
        job_id._obj.value = 41
        return self.create_status

    def cupsStartDestDocument(self, http, dest, info, job, name, fmt, num, opts, last):
        self.calls.append(("start", job, fmt, last))
        return self.start_status

    def cupsWriteRequestData(self, http, data, length):
        self.written += data[:length]
        return 100

    def cupsFinishDestDocument(self, http, dest, info):
        self.calls.append(("finish",))
        return self.finish_status

    def cupsCancelDestJob(self, http, dest, job):
        self.calls.append(("cancel", job))
        return 1

    def cupsFreeDestInfo(self, info):
        self.calls.append(("free-info",))

    def cupsFreeOptions(self, num, opts):
        self.calls.append(("free-options", num))

    def cupsFreeDests(self, num, dest):
        self.calls.append(("free-dests", num))


class TestSubmission:
    def test_the_documented_sequence_spools_the_file_as_pdf(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        lib = _FakeCups()
        job = cups_print.submit(src, "Office", "in.pdf", [("sides", "one-sided")], lib=lib)
        assert job == 41
        names = [c[0] for c in lib.calls]
        assert names == ["dest", "create", "start", "finish", "free-info", "free-options", "free-dests"]
        assert lib.calls[2] == ("start", 41, b"application/pdf", 1)
        with open(src, "rb") as f:
            assert bytes(lib.written) == f.read()

    def test_the_jobs_options_override_the_saved_ones(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        lib = _FakeCups(saved=[("sides", "two-sided-long-edge"), ("media", "na_letter_8.5x11in")])
        cups_print.submit(src, "Office", "t", [("sides", "one-sided")], lib=lib)
        assert lib.added == [("media", "na_letter_8.5x11in"), ("sides", "one-sided")]

    def test_an_instance_reaches_the_named_destination(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        lib = _FakeCups()
        cups_print.submit(src, "Office/draft", "t", [], lib=lib)
        assert lib.calls[0] == ("dest", b"Office", b"draft")

    def test_an_unknown_destination_is_refused_by_name(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        with pytest.raises(ValueError, match="Unknown printer: 'Nowhere'"):
            cups_print.submit(src, "Nowhere", "t", [], lib=_FakeCups(found=False))

    def test_a_refused_document_cancels_its_job(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        lib = _FakeCups(start_status=401)
        with pytest.raises(RuntimeError, match="refused the document"):
            cups_print.submit(src, "Office", "t", [], lib=lib)
        assert ("cancel", 41) in lib.calls
        assert ("free-dests", 1) in lib.calls

    def test_a_refused_job_names_the_printer(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        with pytest.raises(RuntimeError, match="'Office' refused the job"):
            cups_print.submit(src, "Office", "t", [], lib=_FakeCups(create_status=0x0507))

    def test_each_collated_copy_is_its_own_job(self, tmp_path):
        src = _pdf(str(tmp_path / "in.pdf"), [([0, 0, 200, 300], None)])
        lib = _FakeCups()
        ids = cups_print.print_file(
            src, "Office", "", "fit", "printer", None, "auto", "printer", "t", 3, lib=lib
        )
        assert ids == [41, 41, 41]
        assert sum(1 for c in lib.calls if c[0] == "create") == 3


class TestPrintPdfRoutesToCups:
    def test_the_plain_path_spools_the_original_with_its_page_list(
        self, sample_pdf, monkeypatch
    ):
        seen = []
        monkeypatch.setattr(printer_mod, "_SPOOL_THROUGH_CUPS", True)
        monkeypatch.setattr(printer_mod, "printer_exists", lambda name: True)
        monkeypatch.setattr(
            cups_print, "print_file", lambda *a, **k: seen.append(a)
        )
        r = printer_mod.print_pdf(
            file=sample_pdf, printer="Office", pages="1-2, 4", copies=2, fit="actual",
            duplex="long", paper="iso_a4_210x297mm", orientation="portrait", color="gray",
        )
        assert seen == [(
            sample_pdf, "Office", "1-2,4", "actual", "long", "iso_a4_210x297mm",
            "portrait", "gray", os.path.basename(sample_pdf), 2,
        )]
        assert r["jobs"] == 2 and r["paper"] == "iso_a4_210x297mm"

    def test_a_dmpaper_number_is_not_a_cups_paper(self, sample_pdf, monkeypatch):
        monkeypatch.setattr(printer_mod, "_SPOOL_THROUGH_CUPS", True)
        monkeypatch.setattr(printer_mod, "printer_exists", lambda name: True)
        with pytest.raises(ValueError, match="paper"):
            printer_mod.print_pdf(file=sample_pdf, printer="Office", paper=9)

    def test_the_prepared_path_spools_the_prepared_file_once_per_copy(
        self, sample_pdf, monkeypatch
    ):
        seen = []
        monkeypatch.setattr(printer_mod, "_SPOOL_THROUGH_CUPS", True)
        monkeypatch.setattr(printer_mod, "printer_exists", lambda name: True)

        def capture(path, *rest, **kw):
            with pikepdf.open(path) as pdf:
                seen.append((len(pdf.pages), rest))

        monkeypatch.setattr(cups_print, "print_file", capture)
        printer_mod.print_pdf(file=sample_pdf, printer="Office", reverse=True, copies=2)
        (pages, rest), = seen
        assert pages == 5
        assert rest[1] == "" and rest[-1] == 2
