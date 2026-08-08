"""Links authored from the addresses in a document's own text."""

import os

import pikepdf
import pytest

from engine.links import create_links_from_urls, find_url_links, list_links


def _doc(path, lines, size=(500, 700)):
    """A page whose text is exactly `lines`, one show operator per line."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=size)
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
    )
    body = "\n".join(
        f"BT /F1 11 Tf 50 {600 - i * 30} Td ({text}) Tj ET" for i, text in enumerate(lines)
    )
    page.obj[pikepdf.Name.Contents] = pdf.make_stream(body.encode("ascii"))
    page.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font)
    )
    pdf.save(path)
    return path


@pytest.fixture
def addressed(tmp_dir):
    return _doc(
        os.path.join(tmp_dir, "addresses.pdf"),
        [
            "Visit https://example.com/a. for the guide",
            "Write to press@example.org today",
            "Also see www.example.co.uk and Fig.2",
            "Nothing here but v1.0.25 and report.pdf",
        ],
    )


class TestFind:
    def test_reads_without_writing(self, addressed):
        before = os.path.getsize(addressed)
        found = find_url_links(addressed)
        assert found["count"] == 3
        assert os.path.getsize(addressed) == before

    def test_every_candidate_carries_a_target_and_a_rect(self, addressed):
        for candidate in find_url_links(addressed)["candidates"]:
            assert candidate["url"]
            assert candidate["rects"]
            for rect in candidate["rects"]:
                assert rect[2] > rect[0] and rect[3] > rect[1]

    def test_lookalikes_are_not_offered(self, addressed):
        texts = [c["text"] for c in find_url_links(addressed)["candidates"]]
        assert "Fig.2" not in texts
        assert "report.pdf" not in texts
        assert "v1.0.25" not in texts

    def test_emails_can_be_left_out(self, addressed):
        with_mail = find_url_links(addressed, emails=True)["count"]
        without = find_url_links(addressed, emails=False)
        assert without["count"] == with_mail - 1
        assert all(c["kind"] == "url" for c in without["candidates"])

    def test_a_mailto_url_is_one_candidate_not_two(self, tmp_dir):
        path = _doc(os.path.join(tmp_dir, "mailto.pdf"), ["Write mailto:a@example.org now"])
        found = find_url_links(path)
        assert found["count"] == 1
        assert found["candidates"][0]["url"] == "mailto:a@example.org"

    def test_pages_narrow_the_scan(self, tmp_dir):
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(500, 700))
        path = os.path.join(tmp_dir, "two.pdf")
        pdf.save(path)
        # Page 2 carries the address; scanning page 1 alone must find nothing.
        two = _doc(os.path.join(tmp_dir, "src.pdf"), ["See https://example.com/x"])
        with pikepdf.open(path, allow_overwriting_input=True) as base:
            with pikepdf.open(two) as extra:
                base.pages.extend(extra.pages)
            base.save(path)
        assert find_url_links(path, pages=[1])["count"] == 0
        assert find_url_links(path, pages=[2])["count"] == 1


class TestCreate:
    def test_creates_one_annotation_per_address(self, addressed, tmp_dir):
        out = os.path.join(tmp_dir, "linked.pdf")
        result = create_links_from_urls(addressed, out)
        assert result["added"] == 3
        links = list_links(out)["links"]
        assert links[0]["kind"] == "uri"
        targets = sorted(link["target"] for link in links)
        assert targets == [
            "https://example.com/a",
            "https://www.example.co.uk",
            "mailto:press@example.org",
        ]

    def test_the_annotation_rect_matches_the_found_rect(self, addressed, tmp_dir):
        found = find_url_links(addressed)["candidates"]
        out = os.path.join(tmp_dir, "linked.pdf")
        create_links_from_urls(addressed, out)
        by_url = {c["url"]: c["rects"][0] for c in found}
        for link in list_links(out)["links"]:
            expected = by_url[link["target"]]
            assert link["rect"] == pytest.approx(expected, abs=0.01)

    def test_a_second_run_adds_nothing_and_says_why(self, addressed, tmp_dir):
        once = os.path.join(tmp_dir, "once.pdf")
        create_links_from_urls(addressed, once)
        twice = os.path.join(tmp_dir, "twice.pdf")
        again = create_links_from_urls(once, twice)
        assert again["added"] == 0
        assert again["skipped_existing"] == 3
        assert len(list_links(twice)["links"]) == 3

    def test_already_linked_is_reported_by_the_read_too(self, addressed, tmp_dir):
        once = os.path.join(tmp_dir, "once.pdf")
        create_links_from_urls(addressed, once)
        found = find_url_links(once)
        assert found["already_linked"] == 3
        assert all(c["existing"] for c in found["candidates"])

    def test_relinking_can_be_asked_for(self, addressed, tmp_dir):
        once = os.path.join(tmp_dir, "once.pdf")
        create_links_from_urls(addressed, once)
        twice = os.path.join(tmp_dir, "twice.pdf")
        again = create_links_from_urls(once, twice, skip_existing=False)
        assert again["added"] == 3
        assert len(list_links(twice)["links"]) == 6

    def test_a_document_with_no_addresses_refuses_by_name(self, tmp_dir):
        path = _doc(os.path.join(tmp_dir, "plain.pdf"), ["Nothing to see, see Fig.2"])
        with pytest.raises(ValueError, match="No web addresses"):
            create_links_from_urls(path, os.path.join(tmp_dir, "x.pdf"))

    def test_in_place_output_is_supported(self, addressed):
        result = create_links_from_urls(addressed, addressed)
        assert result["added"] == 3
        assert len(list_links(addressed)["links"]) == 3

    def test_a_wrapped_address_links_every_line_it_covers(self, tmp_dir):
        # Two runs on ONE logical line: the search walk reports a rect per RUN,
        # so an address split across runs becomes two annotations rather than
        # one box swallowing the gap between them.
        path = os.path.join(tmp_dir, "wrapped.pdf")
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(500, 700))
        font = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Font,
                Subtype=pikepdf.Name.Type1,
                BaseFont=pikepdf.Name.Helvetica,
            )
        )
        body = "\n".join(
            [
                "BT /F1 11 Tf 50 600 Td (https://example.com/) Tj ET",
                "BT /F1 11 Tf 151.5 600 Td (very/long/path) Tj ET",
            ]
        )
        page.obj[pikepdf.Name.Contents] = pdf.make_stream(body.encode("ascii"))
        page.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=font)
        )
        pdf.save(path)

        found = find_url_links(path)
        assert found["count"] == 1
        assert len(found["candidates"][0]["rects"]) == 2
        out = os.path.join(tmp_dir, "linked.pdf")
        result = create_links_from_urls(path, out)
        assert result["added"] == 1
        assert result["annotations"] == 2
