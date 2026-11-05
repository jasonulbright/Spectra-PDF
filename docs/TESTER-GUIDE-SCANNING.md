# Help us test scanning

Spectra PDF scans straight into a PDF, but it has only ever met one flatbed
scanner. If yours has a **document feeder**, scans **both sides**, has an
**auto-color** setting, or connects over the **network**, you can test
something nobody has been able to — in about five minutes. A plain flatbed
helps too.

## The whole test

1. Install [the latest release](https://github.com/jasonulbright/Spectra-PDF/releases/latest), plug in your scanner, put a printed page in it.
2. Open PowerShell and run:

   ```
   & "$env:ProgramFiles\Spectra PDF\spectrapdf.exe" scan-test
   ```

   If several scanners are attached, the checklist shows a numbered picker.
   You can also pass `--device 1` (or another number from that list); an exact
   device ID from `spectrapdf.exe scanners` works too.

   PowerShell prints one line, "scan-test continues in a new window", and the
   test opens in its **own console window**. Switch to that window. PowerShell
   returns to its prompt right away; that is expected, so leave it alone and
   do your typing in the new window. You do not need
   `Start-Process -Wait -NoNewWindow` or any other wrapper.

3. Answer the prompts in the new window. It tells you when to load the
   feeder, when to press things, and when a step is safe to skip.
4. When it finishes, the window shows the path of the two report files
   (`scan-test-report.json` and `.txt`) and waits. Read it, then press Enter
   to close the window. The window stays open until you do.
5. Attach the two files to a [new GitHub issue](https://github.com/jasonulbright/Spectra-PDF/issues/new).

If you redirect the output or pipe answers in (for a script), no new window
opens and the test runs in the console you started it from.

That's it.

## The sheet-order steps

Two steps ask you to number three sheets by hand and then tell the runner what
each scanned page shows, one page at a time. If your feeder scans both sides,
write 1F/1B on sheet 1, 2F on sheet 2 with **its back left blank**, and 3F/3B
on sheet 3; otherwise just number three fronts 1, 2, 3. The blank side is
deliberate — it catches feeders that quietly skip blank pages — and reading the
pages back is what proves the order, which counting them cannot.

## Privacy

Everything runs offline on your machine and nothing is uploaded. The report
contains your scanner's model, the settings used, and page **measurements**
(sizes, resolutions, pass/fail) — never the scanned images or any text on
them. You see both files before deciding to attach them.

One prompt asks you to power the scanner off mid-scan to test failure
handling. Skip anything you're not comfortable doing — a skipped step is
recorded as skipped and is still useful.
