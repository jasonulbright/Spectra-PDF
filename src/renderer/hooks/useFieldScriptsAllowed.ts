// The one answer to "do field scripts run here", for the canvas, the
// FormsPanel and the settings control alike.
//
// Two inputs: the user's preference (default off) and the machine policy. The
// policy outranks the preference in one direction only — it can take the
// capability away, never grant it — which is why the control it governs has to
// say so rather than claiming to decide something it does not.
import { useEffect, useState } from 'react';
import { getSettings, subscribeSettings } from '../lib/app-settings';
import { fieldScriptsEnabled, scriptSuppression } from '../lib/field-js-policy';
import type { ScriptSuppression } from '../lib/field-js-policy';
import { app } from '../lib/tauri-bridge';

export interface FieldScriptsAllowed {
  enabled: boolean;
  /** Why they are not running, or null when they are. */
  suppression: ScriptSuppression;
  /** True when an administrator has taken the choice away machine-wide, false
   * when the machine key says otherwise, null while the read is still in
   * flight. A surface that WORDS the policy renders nothing for null: on a
   * machine with no policy key at all, saying "locked by policy" until the
   * read lands is a lie every user would see on every open. */
  policyDisabled: boolean | null;
  preference: boolean;
}

export function useFieldScriptsAllowed(): FieldScriptsAllowed {
  const [preference, setPreference] = useState(
    () => getSettings().runUnrecognizedFieldScripts,
  );
  // Starts UNKNOWN. Execution stays fail-closed on it — `fieldScriptsEnabled`
  // requires an explicit `false` — but nothing worded is drawn from a read that
  // has not happened.
  const [policyDisabled, setPolicyDisabled] = useState<boolean | null>(null);

  useEffect(() => subscribeSettings((s) => setPreference(s.runUnrecognizedFieldScripts)), []);

  useEffect(() => {
    let alive = true;
    void app
      .checkFieldScriptsDisabled()
      .then((disabled) => {
        if (alive) setPolicyDisabled(disabled);
      })
      .catch(() => {
        // No policy surface to read (a non-Tauri host): the preference decides.
        if (alive) setPolicyDisabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return {
    enabled: fieldScriptsEnabled(preference, policyDisabled),
    suppression: scriptSuppression(preference, policyDisabled),
    policyDisabled,
    preference,
  };
}
