#!/usr/bin/env python3
"""Release version format `YYYY.MDD.N`, its sequence rule, and the changelog
heading contract.

Field 1 is the year, field 2 the month and day as one integer without zero
padding (Sep 30 -> 930, Oct 4 -> 1004), field 3 the running release number.
Every field stays below 65536 (Windows version resource) and carries no
leading zero (semver parsers refuse one). The updater compares versions as
semver, field by field and numerically, so every date version orders after
every `1.x.y` version and a later release orders after an earlier one exactly
when its date does not go backwards.

  release_version.py check VERSION
  release_version.py release-tag TAG
  release_version.py tag TAG [EXISTING_TAG ...] [--existing-file FILE]
  release_version.py surfaces VERSION [EXISTING_TAG ...]
  release_version.py changelog VERSION [--changelog FILE]

`tag` is the release run's rule: TAG is `v` plus a date version whose number
follows the newest date tag among EXISTING_TAG (TAG itself excluded) by
exactly one, or is FIRST_RELEASE_NUMBER when none exists; --existing-file
reads `git ls-remote --tags` output. `release-tag` accepts any released form,
a date version or a `1.x.y` version, for a rebuild of an existing tag.
`surfaces` is the
pre-push rule: a version that is already tagged passes (the tree is not bumped
yet), any other version must pass `tag`. Exit 0 or 1, reason on stderr.
"""

from __future__ import annotations

import argparse
import calendar
import datetime
import re
import sys
from pathlib import Path
from typing import Iterable, NamedTuple

DATE_VERSION = re.compile(r"^(\d{4})\.(\d{3,4})\.(\d+)$")
LEGACY_VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
FIELD_LIMIT = 65536
FIRST_YEAR = 2026
FIRST_RELEASE_NUMBER = 150

HEADING = re.compile(r"^## (.*)$")
LEGACY_HEADING = re.compile(r"^(\d+\.\d+\.\d+)(?: — .+)?$")
RELEASED_LINE = re.compile(r"^\*Released (\d{4})-(\d{2})-(\d{2})\*$")


class DateVersion(NamedTuple):
    year: int
    month: int
    day: int
    number: int

    @property
    def text(self) -> str:
        return f"{self.year}.{self.month * 100 + self.day}.{self.number}"

    @property
    def date(self) -> tuple[int, int, int]:
        return (self.year, self.month, self.day)


def parse_date_version(version: str) -> DateVersion:
    """The fields of a `YYYY.MDD.N` version; ValueError names the broken rule."""
    m = DATE_VERSION.fullmatch(version)
    if not m:
        raise ValueError(f"'{version}' is not YYYY.MDD.N")
    year_text, mdd_text, number_text = m.groups()
    for text in (year_text, mdd_text, number_text):
        if len(text) > 1 and text.startswith("0"):
            raise ValueError(f"'{version}' carries a leading zero in '{text}'")
    year, mdd, number = int(year_text), int(mdd_text), int(number_text)
    for value in (year, mdd, number):
        if value >= FIELD_LIMIT:
            raise ValueError(f"'{version}': field {value} is not below {FIELD_LIMIT}")
    if year < FIRST_YEAR:
        raise ValueError(f"'{version}': year {year} predates the format ({FIRST_YEAR})")
    month, day = divmod(mdd, 100)
    if not 1 <= month <= 12:
        raise ValueError(f"'{version}': month {month} does not exist")
    if not 1 <= day <= calendar.monthrange(year, month)[1]:
        raise ValueError(f"'{version}': day {day} does not exist in {year}-{month:02d}")
    if number < FIRST_RELEASE_NUMBER:
        raise ValueError(
            f"'{version}': release number {number} is below the first date release "
            f"({FIRST_RELEASE_NUMBER})"
        )
    return DateVersion(year, month, day, number)


def is_legacy_version(version: str) -> bool:
    return LEGACY_VERSION.fullmatch(version) is not None and DATE_VERSION.fullmatch(version) is None


def is_release_version(version: str) -> bool:
    """A date version, or a `1.x.y` version of the released history."""
    try:
        parse_date_version(version)
        return True
    except ValueError:
        return is_legacy_version(version)


def order_key(version: str) -> tuple[int, int, int]:
    """The updater's order: semver precedence over three numeric fields."""
    m = LEGACY_VERSION.fullmatch(version)
    if not m:
        raise ValueError(f"'{version}' is not three numeric fields")
    return tuple(int(g) for g in m.groups())  # type: ignore[return-value]


def _date_tags(tags: Iterable[str], exclude: str) -> list[DateVersion]:
    found = []
    for tag in tags:
        tag = tag.strip()
        if not tag.startswith("v") or tag == exclude:
            continue
        try:
            found.append(parse_date_version(tag[1:]))
        except ValueError:
            continue
    return found


def _local_today() -> datetime.date:
    return datetime.date.today()


def _utc_today() -> datetime.date:
    return datetime.datetime.now(datetime.timezone.utc).date()


def check_next(
    version: str,
    tags: Iterable[str],
    today: datetime.date | None = None,
    release_workflow: bool = False,
) -> DateVersion:
    """`version` is the next release after the date tags in `tags`.

    Every new release must use today's local date. With `release_workflow`,
    `today` is the runner's UTC date and the version date may equal it or the
    day before it: a tag cut in a US evening is already the next day in UTC.
    A date later than the UTC date is always refused. Already published
    versions remain readable through check_release_tag and check_surfaces.
    """
    current = parse_date_version(version)
    previous = _date_tags(tags, exclude=f"v{version}")
    if not previous:
        if current.number != FIRST_RELEASE_NUMBER:
            raise ValueError(
                f"'{version}': no date release is tagged yet, so the release number is "
                f"{FIRST_RELEASE_NUMBER}, not {current.number}"
            )
    else:
        newest = max(previous, key=lambda v: v.number)
        if current.number != newest.number + 1:
            raise ValueError(
                f"'{version}': the newest tag is v{newest.text}, so the release number is "
                f"{newest.number + 1}, not {current.number} (numbers never skip or repeat)"
            )
        if current.date < newest.date:
            raise ValueError(f"'{version}': its date is earlier than v{newest.text}")
    date = datetime.date(*current.date)
    if release_workflow:
        utc_day = today or _utc_today()
        if date not in (utc_day, utc_day - datetime.timedelta(days=1)):
            raise ValueError(
                f"'{version}': its date must be the UTC date ({utc_day}) or the day before it"
            )
        return current
    local_day = today or _local_today()
    if date != local_day:
        raise ValueError(f"'{version}': its date must be today's local date ({local_day})")
    return current


def read_ls_remote(text: str) -> list[str]:
    """Tag names from `git ls-remote --tags --refs` output."""
    names = []
    for line in text.splitlines():
        fields = line.split()
        if fields:
            names.append(fields[-1].removeprefix("refs/tags/"))
    return names


def check_release_tag(tag: str) -> str:
    if not tag.startswith("v") or not is_release_version(tag[1:]):
        raise ValueError(f"tag '{tag}' is not 'v' plus YYYY.MDD.N or a 1.x.y release")
    return tag[1:]


def check_tag(
    tag: str,
    tags: Iterable[str],
    today: datetime.date | None = None,
    release_workflow: bool = False,
) -> DateVersion:
    if not tag.startswith("v"):
        raise ValueError(f"tag '{tag}' does not start with a lowercase 'v'")
    return check_next(tag[1:], tags, today, release_workflow)


def check_surfaces(version: str, tags: Iterable[str], today: datetime.date | None = None) -> str:
    tags = [t.strip() for t in tags]
    if f"v{version}" in tags:
        return f"{version} is already tagged (tree not bumped since that release)"
    try:
        check_next(version, tags, today)
    except ValueError as exc:
        if is_legacy_version(version):
            raise ValueError(f"'{version}': a new release takes YYYY.MDD.N, not a 1.x.y version") from exc
        raise
    return f"{version} is the next release"


def check_changelog(text: str, version: str) -> int:
    """The heading contract. Returns the number of version headings.

    Every `## ` heading is a version: a date version exactly, or a `1.x.y`
    version of the history with an optional ` — title`. Date headings sit
    above all history headings, their numbers fall strictly from the top, and
    a section's `*Released YYYY-MM-DD*` line carries the version's own date.
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if f"## {version}" not in lines:
        raise ValueError(f"CHANGELOG.md has no '## {version}' section")
    headings = 0
    seen_legacy = False
    previous: DateVersion | None = None
    current: DateVersion | None = None
    for number, line in enumerate(lines, start=1):
        released = RELEASED_LINE.fullmatch(line.strip())
        if released and current is not None:
            if tuple(int(g) for g in released.groups()) != current.date:
                raise ValueError(
                    f"CHANGELOG.md:{number}: '{line.strip()}' is not the date of {current.text}"
                )
            continue
        m = HEADING.fullmatch(line)
        if not m:
            continue
        headings += 1
        title = m.group(1)
        if DATE_VERSION.fullmatch(title):
            try:
                current = parse_date_version(title)
            except ValueError as exc:
                raise ValueError(f"CHANGELOG.md:{number}: {exc}") from None
            if seen_legacy:
                raise ValueError(f"CHANGELOG.md:{number}: '## {title}' sits below a 1.x.y heading")
            if previous is not None and current.number >= previous.number:
                raise ValueError(
                    f"CHANGELOG.md:{number}: '## {title}' is not below '## {previous.text}' in number"
                )
            previous = current
            continue
        current = None
        if LEGACY_HEADING.fullmatch(title) and is_legacy_version(title.split(" ", 1)[0]):
            seen_legacy = True
            continue
        raise ValueError(f"CHANGELOG.md:{number}: '## {title}' is not a version heading")
    return headings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check").add_argument("version")
    sub.add_parser("release-tag").add_argument("tag")
    tag = sub.add_parser("tag")
    tag.add_argument("tag")
    tag.add_argument("existing", nargs="*")
    tag.add_argument("--existing-file")
    tag.add_argument("--release-workflow", action="store_true")
    surfaces = sub.add_parser("surfaces")
    surfaces.add_argument("version")
    surfaces.add_argument("existing", nargs="*")
    changelog = sub.add_parser("changelog")
    changelog.add_argument("version")
    changelog.add_argument(
        "--changelog", default=str(Path(__file__).resolve().parents[1] / "CHANGELOG.md")
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            print(f"{parse_date_version(args.version).text} is a valid release version")
        elif args.command == "release-tag":
            print(f"{check_release_tag(args.tag)} is a release version")
        elif args.command == "tag":
            existing = list(args.existing)
            if args.existing_file:
                existing += read_ls_remote(Path(args.existing_file).read_text(encoding="utf-8"))
            print(f"{check_tag(args.tag, existing, release_workflow=args.release_workflow).text} is the next release")
        elif args.command == "surfaces":
            print(check_surfaces(args.version, args.existing))
        else:
            text = Path(args.changelog).read_text(encoding="utf-8")
            count = check_changelog(text, args.version)
            print(f"changelog OK: '## {args.version}' present, {count} version headings")
    except ValueError as exc:
        print(f"release version: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
