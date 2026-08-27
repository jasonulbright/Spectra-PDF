# Help us test scanning

Spectra PDF scans straight into a PDF, but it has only ever met one flatbed
scanner. If yours has a **document feeder**, scans **both sides**, has an
**auto-colour** setting, or connects over the **network**, you can test
something nobody has been able to — in about five minutes. A plain flatbed
helps too.

## The whole test

1. Install [the latest release](https://github.com/jasonulbright/Spectra-PDF/releases/latest), plug in your scanner, put a printed page in it.
2. Open PowerShell and run:

   ```
   & "$env:ProgramFiles\Spectra PDF\spectrapdf.exe" scan-test
   ```

3. Answer the prompts. It tells you when to load the feeder, when to press
   things, and when a step is safe to skip.
4. When it finishes, attach the two files it names (`scan-test-report.json`
   and `.txt`) to a [new GitHub issue](https://github.com/jasonulbright/Spectra-PDF/issues/new).

That's it.

## Privacy

Everything runs offline on your machine and nothing is uploaded. The report
contains your scanner's model, the settings used, and page **measurements**
(sizes, resolutions, pass/fail) — never the scanned images or any text on
them. You see both files before deciding to attach them.

One prompt asks you to power the scanner off mid-scan to test failure
handling. Skip anything you're not comfortable doing — a skipped step is
recorded as skipped and is still useful.
