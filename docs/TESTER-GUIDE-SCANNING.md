# Help us test scanning

Spectra PDF can scan straight into a PDF. The code is written and every part of
it that can be checked without hardware is checked automatically — but a
scanner is a physical machine, and some things can only be proven on one.

The developer's machine has a flatbed scanner and nothing else. That leaves a
list of things nobody has ever been able to try: document feeders, two-sided
scanning, automatic colour detection, network scanners, paper jams, an empty
feeder tray. **If you own a scanner that can do any of those, you can close one
of those gaps in about five minutes.**

Everything below runs on your machine, offline. Nothing is uploaded, and
nothing contacts us. At the end you get two files; you decide whether to send
them.

---

## 1. Does your scanner qualify?

Any scanner is useful. These are the ones we especially need:

| If your scanner has… | …it can close |
| --- | --- |
| A **document feeder** (a tray on top you stack pages into, sometimes called an ADF) | rows 4, 6, 7, 8, 9 |
| A feeder that scans **both sides** of a sheet in one pass | row 5 |
| A **"detect automatically" / "auto colour"** setting in its own scan software | row 3 |
| A **network connection** — it scans over Wi-Fi or Ethernet with no USB cable | row 14 |
| Just a **flatbed** (a sheet of glass and a lid) | rows 1, 2, 11, 12 — still useful, they re-check work that has only ever been checked on one model |

Requirements: Windows 10 or 11, and a scanner that works in Windows' own
scanning software. If Windows can scan from it, we can.

You do **not** need to install anything beyond Spectra PDF itself, and you do
not need any programming knowledge. The whole thing is a series of plain
questions in a terminal window.

---

## 2. What gets collected — and what does not

**Your scans stay on your machine.** The report contains no image content and
no page text. What it does contain:

- **About your scanner:** the make and model name its driver reports, its
  device id, and the settings it says it supports (resolutions, colour modes,
  sources, brightness range, and so on).
- **About your PC:** the Windows build number and the Spectra PDF version.
- **About each test:** which settings the test asked for, whether it passed,
  how long it took, any error the scanner reported, and your yes/no answers to
  the questions it asks you.
- **Measurements of the pages that came back:** their size in pixels, the
  resolution recorded in the image, the colour depth, whether the file is
  complete, and five summary numbers describing how light or dark the page was
  overall. Those five numbers are what tell us "a real page came back" rather
  than "a blank or black rectangle came back". They are a summary of the whole
  page and cannot be turned back into an image.

**The scanned pages themselves are deleted when each test finishes.** They are
only kept if you add `--attach-scans`, which is off by default and which you
should use only if you scanned something you are happy to share — a printed
page from a manual, not a bank statement.

Before you send anything, open the `.txt` report and read it. It is written to
be readable. If there is something in it you would rather not share, don't
send it, or tell us what it said in your own words instead.

---

## 3. Running the checklist

1. Install Spectra PDF and connect your scanner. Check that it works in
   Windows' own scanning app first — if it doesn't work there, nothing we do
   will help.
2. Open a terminal (press Start, type `powershell`, press Enter) in a folder
   you can find again, for example your Desktop:

   ```
   cd $HOME\Desktop
   ```

3. See what the checklist would ask of you, without touching the scanner:

   ```
   & "C:\Program Files\Spectra PDF\spectrapdf.exe" scan-test --list
   ```

   That prints every row, what hardware it needs and roughly how long it takes.
   Rows your scanner cannot do are skipped automatically — a skip is a normal
   result, not a failure.

4. Run it:

   ```
   & "C:\Program Files\Spectra PDF\spectrapdf.exe" scan-test
   ```

   It finds your scanner, tells you what it can see, and then walks you through
   the rows one at a time. Each row says what it needs from you ("load five
   numbered sheets in the feeder"), waits for you to press Enter, runs, and
   tells you what it found. You can answer `n` to skip any row.

5. To run only certain rows — useful if you are coming back to finish, or if
   you only have five minutes:

   ```
   & "C:\Program Files\Spectra PDF\spectrapdf.exe" scan-test --rows 4,6,7
   ```

A full run on a feeder scanner takes about 30 minutes with breaks; individual
rows are 2 to 6 minutes each. Please have about ten sheets of printed paper to
hand — ordinary printed pages, not blank ones, because a blank sheet cannot
prove that a scan worked.

### The rows that need a firm hand

Three rows ask you to do something that feels wrong:

- **Row 7** asks you to stop a run part-way through. Load ten sheets, let a few
  go through, then press Enter. This checks that the pages that finished are
  still offered to you instead of being thrown away.
- **Row 9** asks you to cause a misfeed. A folded corner or a deliberately
  skewed sheet is the usual way. **Do not force anything and do not use
  anything that could damage the scanner** — if you would rather not, answer
  `n` and skip it.
- **Row 10** asks you to switch the scanner off (or unplug it) in the middle of
  a scan. This is safe; it is exactly what happens when someone trips over a
  cable, and we need to know the app says so clearly instead of hanging or
  producing a half-page. You will be asked to switch it back on afterwards.

---

## 4. Sending the results

When the run ends, two files are written next to wherever you ran it:

- `scan-test-report.txt` — the readable one. Open it and have a look.
- `scan-test-report.json` — the same thing in a form we can process.

Then:

1. Go to the project's **Issues** page on GitHub and open a new issue.
2. Title it something like `Scanner checklist: <your scanner model>`.
3. **Attach both files** (drag them into the issue box).
4. Tell us anything the report cannot know: whether a page came out sideways,
   whether the scanner made an unhappy noise, whether a message on screen was
   confusing or worded badly. Wording complaints are genuinely useful — an
   error nobody can act on is a bug even when the code did the right thing.

If a row failed, that is the best possible outcome: it is exactly what this
exercise is for, and it means your scanner found something the developer's
could not.

Thank you. Every row a volunteer closes is a row that was otherwise going to
stay unproven.
