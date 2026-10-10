import type { ImportFormat } from "./api.ts";

/**
 * Picks the import format from a file's own name (#59): OFX, QIF and CAMT.053 are
 * self-describing (design.md) and need no column mapping, so the only thing that matters is
 * telling them apart from a plain CSV export — by extension, the same cue a real bank download's
 * own file name already gives.
 */
export function detectImportFormat(fileName: string): ImportFormat {
  const extension = fileName.toLowerCase().split(".").pop();
  switch (extension) {
    case "ofx":
      return "ofx";
    case "qif":
      return "qif";
    case "xml":
      return "camt053";
    default:
      return "csv";
  }
}
