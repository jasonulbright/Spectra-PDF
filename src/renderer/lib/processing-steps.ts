// What the Layers panel makes of a layer's processing-step declaration.
//
// There is no DOM test environment here, so the decisions live in this module
// where they are testable and the panel only renders what they return.
//
// The standard behind the declaration is ISO 19593-1, which this repository
// does not hold — `src/engine/processing_steps.py` records that gap and names
// what the engine's reading IS sourced from. Nothing here adds a claim to it:
// the engine sends the group, the type and what it made of them, and this
// module chooses words.

import { tChrome } from '../i18n';

/** What a layer declares about being a manufacturing step rather than
 *  artwork. `group` and `type` are the document's own names. */
export interface ProcessingStep {
  group: string;
  type: string;
  status: string;
  page_element: string;
}

/**
 * The declared step as one line: `Group / Type`, or the group alone where the
 * group defines no types.
 *
 * Composed here rather than interpolated into a catalog string because BOTH
 * halves are document content: an ink name, a layer name and a processing
 * step's group are things the file says, and a translated one would name a
 * step the document does not carry.
 */
export function processingStepLabel(step: ProcessingStep): string {
  return step.type ? `${step.group} / ${step.type}` : step.group;
}

/**
 * The note beside a declaration the engine could not take at face value, or
 * '' where it could.
 *
 * `unregistered` is a question, not a verdict. The vocabulary the engine
 * matches against is second-hand, so a name outside it means "confirm this",
 * and the wording has to stay a question — telling a packaging operator their
 * conforming file is wrong costs a print run.
 */
export function processingStepNote(status: string): string {
  switch (status) {
    case 'missing_group':
      return tChrome('panel.layers.stepNoGroup');
    case 'type_on_untyped_group':
      return tChrome('panel.layers.stepTypeOnUntypedGroup');
    case 'unregistered':
      return tChrome('panel.layers.stepUnregistered');
    case 'custom':
      return tChrome('panel.layers.stepCustom');
    default:
      return '';
  }
}
