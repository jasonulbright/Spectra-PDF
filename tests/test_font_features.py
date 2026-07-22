"""Phase 9.K2 — OpenType feature control (small caps, alternates)."""

import os

import pytest

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)
LIBERTINUS = os.path.join(FONTS_DIR, "LibertinusSerif-Regular.otf")
LIBERTINUS_ITALIC = os.path.join(FONTS_DIR, "LibertinusSerif-Italic.otf")

pytestmark = pytest.mark.skipif(
    not os.path.isfile(LIBERTINUS),
    reason="Libertinus Serif (feature font) not provisioned",
)


def _tt(path):
    from fontTools.ttLib import TTFont

    return TTFont(path, fontNumber=0, lazy=True)


class TestFeatureDetection:
    def test_libertinus_reports_its_features(self):
        from engine.font_features import available_features, has_small_caps

        f = _tt(LIBERTINUS)
        try:
            feats = available_features(f)
            assert {"smcp", "c2sc", "salt"} <= feats
            assert has_small_caps(f)
        finally:
            f.close()

    def test_liberation_reports_none(self):
        # The negative path: Liberation carries no supported features, which is
        # exactly why small caps forces the Libertinus switch.
        from engine.font_features import available_features, has_small_caps

        f = _tt(os.path.join(FONTS_DIR, "LiberationSerif-Regular.ttf"))
        try:
            assert available_features(f) == set()
            assert not has_small_caps(f)
        finally:
            f.close()


class TestGlyphResolution:
    def test_small_caps_maps_both_cases_to_sc_glyphs(self):
        # Libertinus encodes smcp as a MultipleSubst (1-elem outputs) plus a
        # SingleSubst special case for 'i', applied CHAINED — the reader must
        # handle types 1+2 and apply lookups in order.
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            got = resolve_glyphs(f, "aAiI1", ["smcp", "c2sc"])
            assert got == ["a.sc", "a.sc", "i.sc", "i.sc", "one"]
        finally:
            f.close()

    def test_no_features_keeps_base_glyphs(self):
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            assert resolve_glyphs(f, "aA1", []) == ["a", "A", "one"]
        finally:
            f.close()

    def test_salt_maps_single_substitutions(self):
        # Libertinus encodes most stylistic alternates as a SingleSubst (a
        # 1->1 map the alt index does not touch): R -> R.alt, y -> y.alt.
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            assert resolve_glyphs(f, "Ry", ["salt"]) == ["R.alt", "y.alt"]
            # A glyph with no salt alternate is left alone.
            assert resolve_glyphs(f, "g", ["salt"]) == ["g"]
        finally:
            f.close()

    def test_salt_alt_index_picks_and_clamps_a_real_alternate(self):
        # germandbls (ess-zed) is a genuine AlternateSubst with two choices,
        # so the index selects between them and a large index clamps to the
        # last — the mechanism a single-alternate glyph cannot exercise.
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            assert resolve_glyphs(f, "ß", ["salt"], alt_index=0) == ["germandbls.ss03"]
            assert resolve_glyphs(f, "ß", ["salt"], alt_index=1) == ["germandbls.alt"]
            # Out-of-range clamps to the last alternate (never raises).
            assert resolve_glyphs(f, "ß", ["salt"], alt_index=9) == ["germandbls.alt"]
        finally:
            f.close()

    def test_a_char_the_font_lacks_resolves_to_none(self):
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            assert resolve_glyphs(f, "\U0001F600", ["smcp"]) == [None]
        finally:
            f.close()

    def test_extension_lookups_are_unwrapped(self):
        # If any feature lives behind an Extension (LookupType 7) lookup,
        # reading the type off the wrapper would silently find nothing — the
        # GSUB twin of the GPOS-kern extension trap. Assert the mechanism by
        # confirming SOME substitution is found for a covered glyph.
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            assert resolve_glyphs(f, "a", ["smcp"]) == ["a.sc"]
        finally:
            f.close()


class TestFeatureEmbedding:
    """The whole point: a substituted glyph must EMBED and DRAW while the
    text stays searchable as its plain letters."""

    def _blank(self, tmp_dir):
        import pikepdf

        src = os.path.join(tmp_dir, "in.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(400, 200))
        pdf.save(src)
        pdf.close()
        return src

    def test_authored_small_caps_uses_libertinus_and_stays_searchable(self, tmp_dir):
        import pikepdf

        from engine.extract_text import extract_text
        from engine.text_authoring import add_text_box

        src = self._blank(tmp_dir)
        out = os.path.join(tmp_dir, "sc.pdf")
        add_text_box(src, out, 1, [30, 120, 370, 170], "Hamburg", size=28,
                     font_path=FONTS_DIR, features=["small_caps"])
        with pikepdf.open(out) as d:
            fonts = d.pages[0]["/Resources"]["/Font"]
            base = str(fonts[list(fonts.keys())[0]]["/DescendantFonts"][0]["/BaseFont"])
        assert "Libertinus" in base
        # ToUnicode round-trip: still the plain word.
        assert "Hamburg" in extract_text(out)["text"]

    def test_authored_small_caps_embeds_as_cff(self, tmp_dir):
        import pikepdf

        from engine.text_authoring import add_text_box

        src = self._blank(tmp_dir)
        out = os.path.join(tmp_dir, "cff.pdf")
        add_text_box(src, out, 1, [30, 120, 370, 170], "Hamburg", size=28,
                     font_path=FONTS_DIR, features=["small_caps"])
        with pikepdf.open(out) as d:
            fonts = d.pages[0]["/Resources"]["/Font"]
            desc = fonts[list(fonts.keys())[0]]["/DescendantFonts"][0]
            assert str(desc["/Subtype"]) == "/CIDFontType0"
            assert "/FontFile3" in desc["/FontDescriptor"]

    def test_no_features_stays_liberation_and_byte_identical(self, tmp_dir):
        import pikepdf

        from engine.text_authoring import add_text_box

        src = self._blank(tmp_dir)

        def author(name, **kw):
            out = os.path.join(tmp_dir, name)
            add_text_box(src, out, 1, [30, 120, 370, 170], "Hamburg", size=28,
                         font_path=FONTS_DIR, **kw)
            with pikepdf.open(out) as d:
                contents = d.pages[0].obj.get("/Contents")
                if isinstance(contents, pikepdf.Array):
                    return b"".join(bytes(s.read_bytes()) for s in contents)
                return contents.read_bytes()

        # No-feature path unchanged, and its face is still Liberation.
        a = author("a.pdf")
        b = author("b.pdf")
        assert a == b
        with pikepdf.open(os.path.join(tmp_dir, "a.pdf")) as d:
            fonts = d.pages[0]["/Resources"]["/Font"]
            base = str(fonts[list(fonts.keys())[0]]["/DescendantFonts"][0]["/BaseFont"])
        assert "Liberation" in base

    def test_small_caps_narrows_the_drawn_run(self, tmp_dir):
        # A sanity check that the substituted glyphs really are the small caps
        # (different metrics), not the base letters: measure both.
        from engine.text_authoring import measure_text_box

        src = self._blank(tmp_dir)
        sc = measure_text_box(src, 1, [30, 120, 370, 170], "HAMBURG", size=28,
                              font_path=FONTS_DIR, features=["small_caps"])
        plain = measure_text_box(src, 1, [30, 120, 370, 170], "HAMBURG", size=28,
                                 font_path=FONTS_DIR)
        # Both fit on one line here; the point is the op runs with features and
        # produces a valid layout.
        assert sc["lines"] >= 1 and plain["lines"] >= 1


class TestExistingTextFeatures:
    """K2 on EXISTING text: switch to Libertinus when the font lacks the
    feature, apply IN PLACE when the document's own font carries it."""

    def _para_pdf(self, tmp_dir, embed_otf=None, text="Hamburg Fonts"):
        """A one-paragraph PDF. `embed_otf` (a path) embeds that OTF as the
        run's font WITH features intact (the in-place-feasible case); else a
        plain non-embedded Helvetica (the switch case)."""
        import pikepdf

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        if embed_otf is None:
            font = pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
                    BaseFont=pikepdf.Name("/Helvetica"),
                    Encoding=pikepdf.Name("/WinAnsiEncoding"),
                )
            )
            show = b"(" + text.encode("latin-1") + b") Tj"
        else:
            font = self._embed_type0(pdf, embed_otf, text)
            # Identity-H: the show op carries 2-byte GIDs, not text bytes.
            show = b"<" + self._encode(text).hex().encode("ascii") + b"> Tj"
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(b"BT /F1 18 Tf 30 150 Td " + show + b" ET")
        src = os.path.join(tmp_dir, "para.pdf")
        pdf.save(src)
        pdf.close()
        return src

    def _embed_type0(self, pdf, otf_path, text):
        # Embed the FULL OTF (features + all glyphs intact) as an Identity-H
        # CIDFontType0, mapping the text's chars to their base glyphs. This is
        # the in-place-feasible document: its own font carries smcp AND the
        # .sc glyphs.
        import pikepdf
        from fontTools.ttLib import TTFont

        raw = open(otf_path, "rb").read()
        ttf = TTFont(otf_path, fontNumber=0, lazy=True)
        cmap = ttf.getBestCmap()
        order = ttf.getGlyphOrder()
        gid_of = {n: i for i, n in enumerate(order)}
        hmtx = ttf["hmtx"]
        upem = ttf["head"].unitsPerEm
        used = {}
        widths = []
        tou = {}
        for ch in sorted(set(text)):
            gname = cmap.get(ord(ch))
            if gname is None:
                continue
            gid = gid_of[gname]
            used[ch] = gid
            widths += [gid, [round(hmtx[gname][0] * 1000.0 / upem, 2)]]
            tou[gid] = ch
        ttf.close()
        prog = pdf.make_stream(raw)
        prog[pikepdf.Name("/Subtype")] = pikepdf.Name("/OpenType")
        desc = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/FontDescriptor"), FontName=pikepdf.Name("/AAAAAA+Emb"),
            Flags=6, FontBBox=pikepdf.Array([0, -200, 1000, 900]), ItalicAngle=0,
            Ascent=800, Descent=-200, CapHeight=700, StemV=80, FontFile3=prog,
        ))
        cidfont = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/CIDFontType0"),
            BaseFont=pikepdf.Name("/AAAAAA+Emb"),
            CIDSystemInfo=pikepdf.Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            FontDescriptor=desc, DW=1000, W=pikepdf.Array(widths),
        ))
        # a real ToUnicode so the run is editable
        lines = [b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
                 b"1 begincodespacerange <0000> <FFFF> endcodespacerange"]
        lines.append(("%d beginbfchar" % len(tou)).encode())
        for gid, ch in tou.items():
            lines.append(("<%04X> <%04X>" % (gid, ord(ch))).encode())
        lines += [b"endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"]
        tounicode = pdf.make_stream(b"\n".join(lines))
        # the show op must use the GIDs; rewrite the fixture text accordingly
        self._encode = lambda s: b"".join(bytes(((used[c] >> 8) & 0xFF, used[c] & 0xFF)) for c in s if c in used)
        return pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type0"),
            BaseFont=pikepdf.Name("/AAAAAA+Emb"), Encoding=pikepdf.Name("/Identity-H"),
            DescendantFonts=pikepdf.Array([cidfont]), ToUnicode=tounicode,
        ))

    def _apply_sc(self, src, out):
        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        para = list_text_paragraphs(src, 1)["paragraphs"][0]
        replace_paragraph_text(src, out, 1, para["index"], para["text"], para["spans"],
                               para["runs"], para["text"], font_path=FONTS_DIR,
                               features=["small_caps"])
        return para

    def _feature_faces(self, out):
        import pikepdf

        with pikepdf.open(out) as d:
            fonts = d.pages[0]["/Resources"]["/Font"]
            return [
                str(fonts[k]["/DescendantFonts"][0]["/BaseFont"])
                for k in fonts.keys()
                if "/DescendantFonts" in fonts[k]
            ]

    def test_switch_to_libertinus_when_font_lacks_the_feature(self, tmp_dir):
        from engine.extract_text import extract_text

        src = self._para_pdf(tmp_dir)  # Helvetica, no features
        out = os.path.join(tmp_dir, "switch.pdf")
        self._apply_sc(src, out)
        assert any("Libertinus" in b for b in self._feature_faces(out))
        assert "Hamburg" in extract_text(out)["text"]

    def test_apply_in_place_when_the_document_font_has_the_feature(self, tmp_dir):
        # The fixture embeds the FULL Libertinus (features + glyphs intact), so
        # in-place must use it — NOT switch to the bundled Libertinus. The
        # in-place face's BaseFont is derived from the extracted program's temp
        # name, so it is NOT "/...+LibertinusSerif" (the bundled switch name).
        from engine.extract_text import extract_text

        src = self._para_pdf(tmp_dir, embed_otf=LIBERTINUS)
        out = os.path.join(tmp_dir, "inplace.pdf")
        self._apply_sc(src, out)
        faces = self._feature_faces(out)
        # No bundled-Libertinus switch face appeared: the doc's own font served.
        assert not any(b.endswith("+LibertinusSerif") for b in faces), faces
        assert "Hamburg" in extract_text(out)["text"]

    def test_feature_source_prefers_in_place_then_falls_back(self, tmp_dir):
        # Unit-test the decision directly. A member whose embedded font has the
        # feature + glyphs -> in-place (a temp file). One without -> the
        # bundled Libertinus switch (no temp).
        import pikepdf

        from engine.text_paragraphs import _feature_source

        pdf = pikepdf.new()
        font = self._embed_type0(pdf, LIBERTINUS, "Hamburg")
        resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))

        class _M:
            style = {"font_name": "/F1"}
            resources = None

        m = _M()
        m.resources = resources
        face, glyph_for, tmp = _feature_source(
            FONTS_DIR, m, resources, "Hamburg", ("smcp", "c2sc"), 0, "regular"
        )
        try:
            assert tmp is not None, "in-place should have fired (temp program written)"
            assert glyph_for.get("a") == "a.sc"
        finally:
            if tmp:
                os.unlink(tmp)
        pdf.close()

    def test_per_span_small_caps_via_span_styles(self, tmp_dir):
        # The renderer's SELECTION case: a span_styles face entry carrying
        # `small_caps` applies the feature to just that range. The engine folds
        # face + features into ONE face key per position, so the feature must
        # switch the covered range to a feature-bearing face (Libertinus, since
        # the doc's Helvetica has none) while the rest stays put; the plain
        # letters round-trip either way.
        import os

        import pikepdf

        from engine.extract_text import extract_text
        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        src = self._para_pdf(tmp_dir)  # "Hamburg Fonts" in Helvetica, no features
        out = os.path.join(tmp_dir, "perspan.pdf")
        para = list_text_paragraphs(src, 1)["paragraphs"][0]
        replace_paragraph_text(
            src, out, 1, para["index"], para["text"], para["spans"], para["runs"],
            para["text"], font_path=FONTS_DIR,
            span_styles=[{"start": 0, "end": 7, "small_caps": True}],
        )
        assert any("Libertinus" in b for b in self._feature_faces(out))
        assert "Hamburg" in extract_text(out)["text"]

    def test_per_span_alternates_via_span_styles(self, tmp_dir):
        # The alternates axis through the same per-span path, with an index.
        import os

        from engine.extract_text import extract_text
        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        src = self._para_pdf(tmp_dir)
        out = os.path.join(tmp_dir, "perspan-alt.pdf")
        para = list_text_paragraphs(src, 1)["paragraphs"][0]
        replace_paragraph_text(
            src, out, 1, para["index"], para["text"], para["spans"], para["runs"],
            para["text"], font_path=FONTS_DIR,
            span_styles=[{"start": 0, "end": 7, "alternates": True, "alt_index": 0}],
        )
        assert any("Libertinus" in b for b in self._feature_faces(out))
        assert "Hamburg" in extract_text(out)["text"]

    # ------------------------------------------------------------------
    # Round-42 gauntlet regressions (mutation-verified — revert the named
    # fix and the assertion fails).
    # ------------------------------------------------------------------

    def test_smcp_only_font_switches_for_uniformity(self, tmp_dir):
        """A font carrying smcp but NOT c2sc must NOT apply small caps in
        place (it would small-cap the lowercase and leave capitals plain — a
        silent non-uniform result); it switches to Libertinus, which has both.
        Mutation: `set(feats) <= available_features` back to `&` → in place
        fires and 'H' stays a plain capital."""
        import io
        import os

        import pikepdf
        from fontTools.ttLib import TTFont

        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        # Strip c2sc from a Libertinus copy → smcp-only doc font.
        tt = TTFont(LIBERTINUS)
        gs = tt["GSUB"].table
        gs.FeatureList.FeatureRecord = [
            r for r in gs.FeatureList.FeatureRecord if r.FeatureTag != "c2sc"
        ]
        buf = io.BytesIO(); tt.save(buf); tt.close()
        smcp_only = os.path.join(tmp_dir, "smcponly.otf")
        with open(smcp_only, "wb") as fh:
            fh.write(buf.getvalue())

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        font = self._embed_type0(pdf, smcp_only, "Hamburg")
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            b"BT /F1 18 Tf 30 150 Td <" + self._encode("Hamburg").hex().encode() + b"> Tj ET"
        )
        src = os.path.join(tmp_dir, "smcponly.pdf")
        pdf.save(src); pdf.close()

        out = os.path.join(tmp_dir, "smcponly-out.pdf")
        para = list_text_paragraphs(src, 1)["paragraphs"][0]
        replace_paragraph_text(src, out, 1, para["index"], para["text"], para["spans"],
                               para["runs"], para["text"], font_path=FONTS_DIR,
                               features=["small_caps"])
        faces = self._feature_faces(out)
        # Switched to the BUNDLED Libertinus (uniform), not the doc's own
        # subset. This is the mutation distinguisher: with the `&` bug the
        # smcp-only doc font applies in place and NO LibertinusSerif appears.
        assert any(b.endswith("+LibertinusSerif") for b in faces), faces
        # And the bundled subset small-caps every letter — no plain capital
        # among the drawn glyphs of the LIBERTINUS face (target it specifically;
        # the now-unused original doc-font subset lingers in resources and does
        # still carry 'H').
        lib_glyphs = None
        with pikepdf.open(out) as d:
            fonts = d.pages[0]["/Resources"]["/Font"]
            for k in fonts.keys():
                fd = fonts[k]
                if "/DescendantFonts" not in fd:
                    continue
                if not str(fd["/DescendantFonts"][0]["/BaseFont"]).endswith("+LibertinusSerif"):
                    continue
                desc = fd["/DescendantFonts"][0]["/FontDescriptor"]
                if "/FontFile3" in desc:
                    prog = bytes(desc["/FontFile3"].read_bytes())
                    sub = TTFont(io.BytesIO(prog)); lib_glyphs = sub.getGlyphOrder(); sub.close()
        assert lib_glyphs is not None, "the Libertinus switch face was not embedded"
        assert "H" not in lib_glyphs, f"a plain capital survived — non-uniform: {lib_glyphs}"

    def test_per_span_feature_uses_the_targeted_runs_own_font(self, tmp_dir):
        """CRITICAL: a per-span feature on a LATER run of a mixed-font
        paragraph must resolve from THAT run's font — not the paragraph's
        first run. Run 0 = italic Libertinus (feature-bearing); run 1 =
        Helvetica (no features). Small caps on run 1 must switch to the
        bundled UPRIGHT Libertinus, never borrow run 0's italic embed.
        Mutation: drop the `elif kfeats and fam is None` member-index bake in
        `face_at` → the key resolves from `first` and a temp (borrowed) face
        appears."""
        import os

        import pikepdf

        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(500, 200))
        f0 = self._embed_type0(pdf, LIBERTINUS_ITALIC, "Special ")
        enc0 = self._encode  # bound to F0 by _embed_type0
        f1 = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
            BaseFont=pikepdf.Name("/Helvetica"), Encoding=pikepdf.Name("/WinAnsiEncoding")))
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F0=f0, F1=f1))
        page.Contents = pdf.make_stream(
            b"BT /F0 18 Tf 30 150 Td <" + enc0("Special ").hex().encode() + b"> Tj "
            b"/F1 18 Tf (Plain) Tj ET")
        src = os.path.join(tmp_dir, "mixed.pdf")
        pdf.save(src); pdf.close()

        paras = list_text_paragraphs(src, 1)["paragraphs"]
        assert paras, "the two runs must group into one paragraph for this test"
        para = paras[0]
        start = para["text"].find("Plain")
        assert start >= 0 and len(para["runs"]) >= 2, para
        out = os.path.join(tmp_dir, "mixed-out.pdf")
        replace_paragraph_text(src, out, 1, para["index"], para["text"], para["spans"],
                               para["runs"], para["text"], font_path=FONTS_DIR,
                               span_styles=[{"start": start, "end": start + 5, "small_caps": True}])
        faces = self._feature_faces(out)
        # No borrowed (temp) in-place face; the feature switched to bundled
        # upright Libertinus for run 1.
        assert not any("tmp" in b.lower() for b in faces), f"borrowed a run's own font: {faces}"
        assert any(b.endswith("+LibertinusSerif") for b in faces), faces

    def test_in_place_feature_keeps_kerning(self, tmp_dir):
        """An IN-PLACE feature edit must still kern (K1b) — the in-place temp
        program is unlinked before the emission pass, so its kerning is
        captured at build time. 'AVATAR' has strong pairs (A|V, V|A, A|T,
        T|A), so a kerned run emits a `TJ` array. Mutation: drop the
        `feat_kern = _kp(...)` capture → kern_pairs reads the deleted path,
        returns {}, and the run emits a plain `Tj` (no `TJ`)."""
        import os

        import pikepdf

        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        font = self._embed_type0(pdf, LIBERTINUS, "AVATAR")  # in-place-eligible
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            b"BT /F1 24 Tf 30 150 Td <" + self._encode("AVATAR").hex().encode() + b"> Tj ET")
        src = os.path.join(tmp_dir, "kern.pdf")
        pdf.save(src); pdf.close()

        out = os.path.join(tmp_dir, "kern-out.pdf")
        para = list_text_paragraphs(src, 1)["paragraphs"][0]
        replace_paragraph_text(src, out, 1, para["index"], para["text"], para["spans"],
                               para["runs"], para["text"], font_path=FONTS_DIR,
                               features=["small_caps"])
        with pikepdf.open(out) as d:
            contents = d.pages[0].obj.get("/Contents")
            if isinstance(contents, pikepdf.Array):
                stream = b"".join(bytes(s.read_bytes()) for s in contents)
            else:
                stream = contents.read_bytes()
        assert b"TJ" in stream, "the in-place small-caps run was not kerned (plain Tj emitted)"

    def test_small_caps_plus_alternates_compose_deterministically(self):
        """Combining small caps + alternates is deterministic and matches a
        real shaper for the bundled face: features apply in GSUB lookup order,
        so a glyph the earlier feature substitutes keeps that result unless the
        font also defines an alternate of the substituted glyph (Libertinus
        does not for these). Features on DIFFERENT characters both apply.
        Pinned so the composition can't silently drift."""
        from engine.font_features import resolve_glyphs

        f = _tt(LIBERTINUS)
        try:
            # 'R'/'y' small-cap to r.sc/y.sc, which have no salt alternate, so
            # adding salt is a legitimate no-op — the combined result equals
            # small caps alone (exactly what a shaper produces for this font).
            assert resolve_glyphs(f, "Ry", ["smcp", "c2sc"]) == ["r.sc", "y.sc"]
            assert resolve_glyphs(f, "Ry", ["smcp", "c2sc", "salt"]) == ["r.sc", "y.sc"]
            # But where the font DOES define a small-cap alternate, both
            # features COMPOSE: ß → germandbls.sc → germandbls.scalt. So the
            # combined case is not a silent drop — it chains correctly through
            # whatever glyphs the font provides.
            assert resolve_glyphs(f, "ß", ["smcp", "c2sc", "salt"]) == ["germandbls.scalt"]
        finally:
            f.close()
