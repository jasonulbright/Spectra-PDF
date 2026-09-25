/**
 * The CSS variables pdf.js's text layer sizes itself by. The layer and every
 * span are `--total-scale-factor` (= `--scale-factor` × `--user-unit`) times
 * the page's raw viewBox extent, while `viewport.scale` excludes /UserUnit.
 * Leaving `--user-unit` unset shrinks the layer by the page's UserUnit, so
 * selection and search hits land off the rendered text on such a page.
 */
export function textLayerScaleVars(viewport: { scale: number; userUnit?: number }): Record<string, string> {
  return {
    '--scale-factor': String(viewport.scale),
    '--user-unit': String(viewport.userUnit ?? 1),
  };
}
