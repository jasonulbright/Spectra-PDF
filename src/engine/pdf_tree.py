"""Shared page-tree helpers.

Several page attributes (/Resources, /Rotate, /MediaBox, /CropBox) are
inheritable per the PDF spec: a page dict lacking its own entry takes it
from the nearest ancestor /Pages node that has one — common output from
generators that hoist a single shared dict onto the tree rather than
duplicating it per page. ``page.obj.get`` alone only ever sees the page's
OWN dict, which silently misreads such files (redaction's inherited-
/Resources false negative was caught by review; watermark needs the same
walk for /Rotate and the boxes). One implementation here so a future fix
propagates to every consumer.
"""

import pikepdf


def walk_inheritable(page: "pikepdf.Page", key: str):
    """Resolve an inheritable page attribute via the /Parent chain.

    Returns the first value found walking from the page up through its
    ancestor /Pages nodes, or None if absent everywhere. The depth cap only
    exists to terminate on malformed cyclic trees.
    """
    node = page.obj
    seen = 0
    while node is not None and seen < 64:
        value = node.get(key)
        if value is not None:
            return value
        node = node.get("/Parent")
        seen += 1
    return None
