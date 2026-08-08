"""Article threads — /Threads read, write and round trip."""

import os

import pikepdf
import pytest

from engine.threads import list_threads, set_threads


@pytest.fixture
def blank(tmp_dir):
    path = os.path.join(tmp_dir, "blank.pdf")
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(400, 600))
    pdf.save(path)
    return path


TWO = [
    {
        "title": "Feature",
        "author": "A. Writer",
        "beads": [
            {"page": 1, "rect": [50, 400, 200, 550]},
            {"page": 2, "rect": [50, 400, 200, 550]},
            {"page": 2, "rect": [220, 400, 370, 550]},
        ],
    },
    {
        "title": "Sidebar",
        "beads": [{"page": 3, "rect": [50, 100, 350, 250]}],
    },
]


class TestRoundTrip:
    def test_written_articles_read_back_identically(self, blank, tmp_dir):
        out = os.path.join(tmp_dir, "threads.pdf")
        result = set_threads(blank, out, TWO)
        assert result["count"] == 2
        assert result["beads"] == 4

        read = list_threads(out)
        assert read["count"] == 2
        assert [t["title"] for t in read["threads"]] == ["Feature", "Sidebar"]
        assert read["threads"][0]["author"] == "A. Writer"
        assert read["threads"][1]["author"] == ""
        assert [b["page"] for b in read["threads"][0]["beads"]] == [1, 2, 2]
        assert read["threads"][0]["beads"][0]["rect"] == [50.0, 400.0, 200.0, 550.0]

    def test_a_document_with_no_articles_reads_empty(self, blank):
        assert list_threads(blank) == {"threads": [], "count": 0}

    def test_in_place_output_is_supported(self, blank):
        set_threads(blank, blank, TWO)
        assert list_threads(blank)["count"] == 2


class TestStructure:
    def test_beads_are_linked_in_a_circle(self, blank, tmp_dir):
        out = os.path.join(tmp_dir, "threads.pdf")
        set_threads(blank, out, TWO)
        with pikepdf.open(out) as pdf:
            thread = pdf.Root["/Threads"][0]
            first = thread["/F"]
            chain = [first]
            node = first["/N"]
            while node.objgen != first.objgen:
                chain.append(node)
                node = node["/N"]
            assert len(chain) == 3
            # Backward links close the same ring.
            assert first["/V"].objgen == chain[-1].objgen
            for i, bead in enumerate(chain):
                assert str(bead["/Type"]) == "/Bead"
                assert bead["/T"].objgen == thread.objgen
                assert bead["/N"].objgen == chain[(i + 1) % 3].objgen
                assert bead["/V"].objgen == chain[(i - 1) % 3].objgen

    def test_pages_list_their_own_beads_in_thread_order(self, blank, tmp_dir):
        out = os.path.join(tmp_dir, "threads.pdf")
        set_threads(blank, out, TWO)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages[0].obj["/B"]) == 1
            assert len(pdf.pages[1].obj["/B"]) == 2
            assert len(pdf.pages[2].obj["/B"]) == 1
            page_two = [b["/R"][0] for b in pdf.pages[1].obj["/B"]]
            assert [float(v) for v in page_two] == [50.0, 220.0]

    def test_the_info_dictionary_carries_only_what_was_given(self, blank, tmp_dir):
        out = os.path.join(tmp_dir, "threads.pdf")
        set_threads(blank, out, TWO)
        with pikepdf.open(out) as pdf:
            info = pdf.Root["/Threads"][0]["/I"]
            assert str(info["/Title"]) == "Feature"
            assert str(info["/Author"]) == "A. Writer"
            assert "/Subject" not in info
            # A thread with no metadata grows no /I at all.
            assert "/I" in pdf.Root["/Threads"][1]

    def test_a_thread_with_no_metadata_has_no_info_dictionary(self, blank, tmp_dir):
        out = os.path.join(tmp_dir, "threads.pdf")
        set_threads(blank, out, [{"beads": [{"page": 1, "rect": [10, 10, 90, 90]}]}])
        with pikepdf.open(out) as pdf:
            assert "/I" not in pdf.Root["/Threads"][0]


class TestReplaceSemantics:
    def test_replacing_removes_the_stale_page_bead_arrays(self, blank, tmp_dir):
        first = os.path.join(tmp_dir, "first.pdf")
        set_threads(blank, first, TWO)
        second = os.path.join(tmp_dir, "second.pdf")
        set_threads(first, second, [{"title": "Only", "beads": [{"page": 1, "rect": [10, 10, 90, 90]}]}])
        with pikepdf.open(second) as pdf:
            assert len(pdf.Root["/Threads"]) == 1
            assert "/B" in pdf.pages[0].obj
            assert "/B" not in pdf.pages[1].obj
            assert "/B" not in pdf.pages[2].obj

    def test_an_empty_list_removes_threads_entirely(self, blank, tmp_dir):
        first = os.path.join(tmp_dir, "first.pdf")
        set_threads(blank, first, TWO)
        cleared = os.path.join(tmp_dir, "cleared.pdf")
        result = set_threads(first, cleared, [])
        assert result["count"] == 0
        with pikepdf.open(cleared) as pdf:
            assert "/Threads" not in pdf.Root
            assert all("/B" not in page.obj for page in pdf.pages)
        assert list_threads(cleared)["count"] == 0


class TestRefusals:
    def test_a_thread_with_no_beads_refuses_by_name(self, blank, tmp_dir):
        with pytest.raises(ValueError, match="no boxes"):
            set_threads(blank, os.path.join(tmp_dir, "x.pdf"), [{"title": "Empty", "beads": []}])

    def test_a_bead_off_the_document_refuses_by_name(self, blank, tmp_dir):
        with pytest.raises(ValueError, match="targets page 9 of 3"):
            set_threads(
                blank,
                os.path.join(tmp_dir, "x.pdf"),
                [{"beads": [{"page": 9, "rect": [10, 10, 90, 90]}]}],
            )

    def test_a_bead_with_no_area_refuses_by_name(self, blank, tmp_dir):
        with pytest.raises(ValueError, match="no area"):
            set_threads(
                blank,
                os.path.join(tmp_dir, "x.pdf"),
                [{"beads": [{"page": 1, "rect": [10, 10, 10, 90]}]}],
            )

    def test_a_bead_with_no_rectangle_refuses_by_name(self, blank, tmp_dir):
        with pytest.raises(ValueError, match="no rectangle"):
            set_threads(blank, os.path.join(tmp_dir, "x.pdf"), [{"beads": [{"page": 1}]}])

    def test_a_bead_with_no_page_refuses_by_name(self, blank, tmp_dir):
        with pytest.raises(ValueError, match="names no page"):
            set_threads(
                blank,
                os.path.join(tmp_dir, "x.pdf"),
                [{"beads": [{"rect": [10, 10, 90, 90]}]}],
            )

    def test_a_non_list_refuses_by_name(self, blank, tmp_dir):
        with pytest.raises(ValueError, match="list of articles"):
            set_threads(blank, os.path.join(tmp_dir, "x.pdf"), {"title": "wrong"})

    def test_a_refusal_names_the_article_and_the_box(self, blank, tmp_dir):
        with pytest.raises(ValueError, match=r"Article 2, box 2"):
            set_threads(
                blank,
                os.path.join(tmp_dir, "x.pdf"),
                [
                    {"beads": [{"page": 1, "rect": [10, 10, 90, 90]}]},
                    {
                        "beads": [
                            {"page": 1, "rect": [10, 10, 90, 90]},
                            {"page": 1, "rect": [10, 10, 10, 90]},
                        ]
                    },
                ],
            )

    def test_a_refused_write_leaves_the_source_untouched(self, blank, tmp_dir):
        first = os.path.join(tmp_dir, "first.pdf")
        set_threads(blank, first, TWO)
        with pytest.raises(ValueError):
            set_threads(first, first, [{"beads": []}])
        assert list_threads(first)["count"] == 2


class TestMalformedInput:
    def test_a_broken_next_chain_terminates(self, blank, tmp_dir):
        out = os.path.join(tmp_dir, "threads.pdf")
        set_threads(blank, out, TWO)
        broken = os.path.join(tmp_dir, "broken.pdf")
        with pikepdf.open(out) as pdf:
            # Point the last bead's /N at itself: a ring that never returns.
            thread = pdf.Root["/Threads"][0]
            last = thread["/F"]["/N"]["/N"]
            last["/N"] = last
            pdf.save(broken)
        read = list_threads(broken)
        assert read["count"] == 2
        assert len(read["threads"][0]["beads"]) == 3
