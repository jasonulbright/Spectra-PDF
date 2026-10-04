# Feedback and development

Thanks for your interest. This is a single-maintainer project, so a note on
how it works before you spend time on anything.

## Reporting things

- **Bugs and feature requests**: open an issue. The templates ask for the
  things that usually decide whether a bug is reproducible.
- **Security issues**: do *not* open a public issue. See
  [SECURITY.md](SECURITY.md) -- crafted-file crashes, redaction that leaves
  content behind, and signature verification that trusts the wrong thing all
  belong there.
- The most valuable thing you can attach is a document that reproduces the
  problem.

## Pull requests

Pull requests are disabled and will not be merged. The maintainer may review
suggested code shared in an issue and implement changes independently.

Contributor credit is reserved for people. Automated tools are not
contributors.

## The bar

A feature ships when it is complete and correct, or it doesn't ship. There are
no partial releases, no feature flags hiding half-built work, and no "we'll
finish it next version". If a capability is present in the product, it is
expected to work fully.

The counterpart: honest refusals are fine. If the app can't do something with a
given file, saying so plainly is a correct outcome. Producing quietly wrong
output is not.

## Building

See the README's Quick Start and Build sections. `npm run prepackage` vendors
every runtime the app needs — embedded Python, Ghostscript, the ICC colour
profiles, the edit fonts, LibreOffice, native Tesseract, and the OCR language
models — and every one of them is required for a build to succeed. On Linux,
install the distribution's `ghostscript` package to work on, or test, the
features that use it. `npm run package:unsigned` is the
local build: prepackage plus the Rust compile and the NSIS installer.
(`npm run package` without `:unsigned` is the release shape — it also signs
the updater artifacts, which needs `TAURI_SIGNING_PRIVATE_KEY`, a key that
lives only in the release workflow's secrets.)

## Licensing

The project is MIT. By contributing you agree your contribution is licensed the
same way. Third-party components are vendored at arm's length and documented in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) -- if a change adds or
updates one, that file is part of the change.
