/**
 * Finds `<tag>…</tag>` blocks in a markup file (OFX, CAMT.053) in linear time
 * (#675). It replaces lazy regular expressions such as
 * `/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi`, which take quadratic time on a file
 * holding many opening tags and no closing one: every opening tag starts a
 * new scan to the end of the file.
 *
 * Same results as those expressions: tags match case-insensitively, each
 * block ends at the first closing tag after its opening tag (lazy), blocks
 * never overlap, and an opening tag with no closing tag after it ends the
 * search (the expressions found nothing past it either).
 *
 * Tag names are ASCII and compared ASCII-case-insensitively in place, the
 * way those expressions (`i`, no `u` flag) compared them: no lowercased copy
 * of the file is made, so nothing allocates in proportion to its size
 * (`String.prototype.toLowerCase` would also shift offsets, since some
 * non-ASCII characters change length when lowercased, and would match the
 * Kelvin sign "\u212A" to "k").
 */

export interface TagBlockOptions {
  /**
   * Whether the opening tag may carry attributes (`<Ntry Id="1">`), as
   * `<tag(?:\s[^>]*)?>` allows; otherwise only the exact `<tag>` opens a block.
   */
  readonly attributes?: boolean;
  /** Stop after this many blocks (1 for the first block only). */
  readonly limit?: number;
}

/** The character code with an ASCII capital letter lowercased; any other character unchanged. */
function lowerAsciiCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/**
 * The first index at or after `from` where `needle` (lowercase ASCII, starting with "<") occurs,
 * ASCII-case-insensitively, or -1. Linear: each "<" is compared against at most the needle's length.
 */
function indexOfTag(content: string, needle: string, from: number): number {
  let index = content.indexOf("<", from);
  while (index !== -1 && index + needle.length <= content.length) {
    let j = 1;
    while (j < needle.length && lowerAsciiCode(content.charCodeAt(index + j)) === needle.charCodeAt(j)) j += 1;
    if (j === needle.length) return index;
    index = content.indexOf("<", index + 1);
  }
  return -1;
}

/** The inner content of each `<tag>…</tag>` block, in file order. */
export function findTagBlocks(content: string, tag: string, options: TagBlockOptions = {}): string[] {
  const name = tag.toLowerCase();
  const open = options.attributes ? `<${name}` : `<${name}>`;
  const close = `</${name}>`;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const blocks: string[] = [];

  let position = 0;
  while (blocks.length < limit) {
    const start = indexOfTag(content, open, position);
    if (start === -1) break;

    let bodyStart = start + open.length;
    if (options.attributes) {
      const next = content[bodyStart];
      if (next === ">") {
        bodyStart += 1;
      } else if (next !== undefined && /\s/.test(next)) {
        const tagEnd = content.indexOf(">", bodyStart);
        // No ">" anywhere after this point: no later opening tag can be complete either.
        if (tagEnd === -1) break;
        bodyStart = tagEnd + 1;
      } else {
        // A longer tag name sharing this prefix (`<DtTm` when looking for `<Dt`).
        position = start + 1;
        continue;
      }
    }

    const end = indexOfTag(content, close, bodyStart);
    // No closing tag after this opening tag: none after any later one either.
    if (end === -1) break;
    blocks.push(content.slice(bodyStart, end));
    position = end + close.length;
  }

  return blocks;
}
