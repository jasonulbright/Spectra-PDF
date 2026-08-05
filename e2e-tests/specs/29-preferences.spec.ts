import { expect } from '@wdio/globals';
import { waitForHarness, invokeAppCommand } from '../support/harness.js';

// Phase 4 M5.5: Preferences is a CATEGORIZED dialog (§ 7), not a flat scroll of
// every setting. Driven through the real DOM — the dialog is pure UI, so
// nothing else can tell whether it works.

describe('preferences dialog', () => {
  it('Ctrl+K opens it on General', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-general"]').waitForDisplayed({
      timeoutMsg: 'Ctrl+K did not open Preferences',
    });
    expect(await $('[data-testid="prefs-cat-general"]').getAttribute('aria-pressed')).toBe('true');
    await expect($('[data-testid="prefs-body-general"]')).toBeDisplayed();
  });

  it('shows ONE category at a time', async () => {
    // The point of the split: the licence notice is not sharing a column with
    // the Ghostscript picker any more.
    await expect($('[data-testid="licenses-note"]')).not.toBeExisting();
    await $('[data-testid="prefs-cat-engine"]').click();
    await expect($('[data-testid="prefs-body-engine"]')).toBeDisplayed();
    await expect($('[data-testid="prefs-body-general"]')).not.toBeExisting();
    await $('[data-testid="prefs-close"]').click();
    await $('[data-testid="prefs-cat-general"]').waitForDisplayed({ reverse: true });
  });

  it('Help ▸ Third-party Licenses lands ON the licences, not at the top of a scroll', async () => {
    // The reason the category is state rather than a boolean: this entry point
    // used to open the same modal and leave the user to find the notice.
    expect(await invokeAppCommand('help.licenses')).toBe(true);
    await $('[data-testid="licenses-note"]').waitForDisplayed({
      timeoutMsg: 'Help ▸ Licenses did not land on the licences',
    });
    expect(await $('[data-testid="prefs-cat-licenses"]').getAttribute('aria-pressed')).toBe('true');
    // The SHIPPED notice files are reachable from here (license-compliance
    // set): both openers render. Existence only — clicking would launch the
    // OS default handler on the runner.
    await expect($('[data-testid="licenses-open-aggregate"]')).toBeDisplayed();
    await expect($('[data-testid="licenses-open-rust"]')).toBeDisplayed();
    await $('[data-testid="prefs-close"]').click();
  });

  // Updates are notify-only: the app never installs anything
  // itself. The launch check is the only part that runs unprompted, so it gets
  // a switch — and that switch shipping ON is what makes the feature exist at
  // all for people who never open Preferences.
  it('the update preference is present, defaults ON, and persists an opt-out', async () => {
    expect(await invokeAppCommand('help.licenses')).toBe(true);
    const box = $('[data-testid="pref-check-updates"]');
    await box.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'the check-for-updates preference is missing',
    });
    expect(await box.isSelected()).toBe(true);

    await box.click();
    await browser.waitUntil(async () => !(await box.isSelected()), {
      timeout: 5_000,
      timeoutMsg: 'unchecking the update preference did not take',
    });
    // It reached storage, not just component state — the launch check reads
    // settings cold on the next start.
    const stored = await browser.execute(
      () => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').checkUpdatesOnLaunch,
    );
    expect(stored).toBe(false);

    // Put it back so the shared workspace isn't left opted out.
    await box.click();
    await browser.waitUntil(async () => await box.isSelected(), { timeout: 5_000 });
    await $('[data-testid="prefs-close"]').click();
  });

  // Issue #1 request 4. Logging ships ON with a 30-day sweep, because the
  // people this serves run batches unattended and will never open Preferences
  // to switch a log on. The retention value is the one that ARMS a delete
  // loop, so it gets pinned in storage, not just eyeballed on screen.
  it('batch logging defaults ON at 30 days and persists a change', async () => {
    await browser.keys(['Control', 'k']);
    const box = $('[data-testid="pref-batch-log"]');
    await box.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'the batch-log preference is missing from General',
    });
    expect(await box.isSelected()).toBe(true);
    const retention = $('[data-testid="pref-batch-log-retention"]');
    expect(await retention.getValue()).toBe('30');

    await retention.selectByAttribute('value', '90');
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').batchLogRetentionDays,
        )) === 90,
      { timeout: 5_000, timeoutMsg: 'the retention change never reached storage' },
    );

    // Turning logging off disables the retention picker rather than leaving a
    // live control that governs nothing.
    await box.click();
    await browser.waitUntil(async () => !(await retention.isEnabled()), {
      timeout: 5_000,
      timeoutMsg: 'retention stayed enabled with logging off',
    });

    // The location is configurable and defaults to the app's own data folder.
    // It exists because a scheduled run under another account resolves that
    // folder inside THAT account's profile, so the log would not be where the
    // person who set it up looks. (The picker itself is a native dialog and
    // not WebDriver-drivable; what is asserted here is that the control is
    // present, says "Default", and offers no stale reset when unset.)
    await expect($('[data-testid="pref-batch-log-dir"]')).toHaveText(/Default/);
    await expect($('[data-testid="pref-batch-log-dir-pick"]')).toBeDisplayed();
    await expect($('[data-testid="pref-batch-log-dir-reset"]')).not.toBeExisting();

    // Leave the shared workspace on the defaults — spec 40 asserts a log gets
    // written, and it runs against whatever this leaves behind.
    await box.click();
    await browser.waitUntil(async () => await box.isSelected(), { timeout: 5_000 });
    await retention.selectByAttribute('value', '30');
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').batchLogRetentionDays,
        )) === 30,
      { timeout: 5_000 },
    );
    await $('[data-testid="prefs-close"]').click();
  });

  // A LIVE theme swap, driven through the real select — spec 97's walk stamps
  // data-theme directly, which is the right shortcut for a colour audit but
  // means nothing here ever exercised applyTheme's ordering. The accent
  // variables are derived FOR a shell; before this, they were derived once
  // (for the dark one) and never re-derived on a switch, so a swap left the
  // accent-as-text colour of the outgoing theme in place — cyan at 2.47:1 on
  // the light shell. The invariant: after every switch, whatever is stamped
  // and whatever --accent-text holds agree, at AA.
  it('re-derives the accent for the theme the swap landed on', async () => {
    const SHELL: Record<string, [number, number, number]> = {
      dark: [0x17, 0x17, 0x17],
      light: [0xff, 0xff, 0xff],
      'high-contrast': [0, 0, 0],
    };

    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    const themeSelect = $('[data-testid="prefs-theme"]');
    await themeSelect.waitForDisplayed({ timeout: 10_000 });

    // Both directions, and the contrast theme, and back through System — the
    // reverse direction is where a stale derivation hides.
    for (const choice of ['light', 'dark', 'light', 'high-contrast', 'dark', 'system']) {
      await themeSelect.selectByAttribute('value', choice);
      const shown = await browser.execute(() => {
        const root = document.documentElement;
        return {
          theme: root.getAttribute('data-theme'),
          text: getComputedStyle(root).getPropertyValue('--accent-text').trim(),
          accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
        };
      });
      // The stamp is synchronous in every branch, System included: the shell
      // never shows the outgoing theme while an IPC round-trip completes.
      if (choice !== 'system') expect(shown.theme).toBe(choice);
      expect(Object.keys(SHELL)).toContain(shown.theme!);
      expect(shown.accent).toMatch(/^#[0-9A-F]{6}$/i);

      const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(shown.text);
      expect(rgb).not.toBeNull();
      const lum = (c: [number, number, number]) => {
        const lin = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
      };
      const l1 = lum([Number(rgb![1]), Number(rgb![2]), Number(rgb![3])]);
      const l2 = lum(SHELL[shown.theme!]);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(shown.theme === 'high-contrast' ? 7 : 4.5);
    }

    await $('[data-testid="prefs-close"]').click();
  });
});
