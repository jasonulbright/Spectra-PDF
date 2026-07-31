# Security Policy

## Reporting a vulnerability

**Please report security issues privately, not as a public issue.**

Use GitHub's [private vulnerability reporting](https://github.com/jasonulbright/Spectra-PDF/security/advisories/new)
(the **Security** tab ▸ *Report a vulnerability*). It creates a private thread
visible only to the maintainer, and it lets us coordinate a fix and an advisory
before details are public.

If that is unavailable to you, open a normal issue asking for a private contact
channel — **without** the vulnerability details.

Please include, as far as you can:

- what the issue is and what an attacker could achieve with it,
- the version (Help ▸ About, or the installer filename),
- a sample file or steps that reproduce it — a malformed PDF that triggers the
  bug is the most useful thing you can send,
- whether the issue needs user interaction (opening a file) or not.

You will get an acknowledgement within about a week. This is a
single-maintainer project, so please be patient with fix timelines; a fix will
ship in the next release, and the advisory will credit you unless you'd rather
it didn't.

## What's in scope

This application opens files it did not create, so parsing untrusted input is
the primary risk surface. In scope:

- crashes, hangs, or memory-safety issues triggered by a crafted PDF (or any
  other input format the app accepts: PostScript/EPS, images, certificates),
- **redaction that does not actually remove content** — the app's redaction is
  true content removal, and any case where redacted text or images survive in
  the output is a security bug, not a cosmetic one,
- **encryption or permissions that don't hold** — a document that can be opened
  or modified without the credentials it should require,
- **signature verification that reports a bad signature as good**, or that
  trusts an anchor the user did not configure,
- anything that reads or writes files outside the paths the user chose,
- anything that makes a network request the user didn't ask for. The app is
  designed to work fully offline: OCR, fonts, and all processing are local.
  Network access is limited to update checks and, only when the user configures
  them, timestamp/revocation servers for digital signatures.

## What's out of scope

- **The installer is unsigned.** Windows SmartScreen warns about it; this is
  documented in the README and is a consequence of not holding a code-signing
  certificate, not a vulnerability. Verify downloads with the SHA-256 checksums
  published alongside each release.
- Vulnerabilities in bundled third-party components (Ghostscript, LibreOffice,
  Tesseract data, Python packages) that are already public and fixed upstream —
  please do report these, but as a normal issue asking for a version bump.
  See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for what ships.
- Attacks that require an attacker to already have code execution or
  administrator rights on the machine.

## Supported versions

Fixes ship in the latest release. There are no long-term support branches; if
you're reporting against an older build, please confirm it still reproduces on
the current release where you can.
