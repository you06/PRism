// ---------------------------------------------------------------------------
// PRism — Patch Normalization & Hashing (extension-local copy)
//
// Keep this logic aligned with shared/src/patch-hash.ts so the extension and
// daemon compute identical patch hashes.
// ---------------------------------------------------------------------------

export type DiffLineType = "add" | "delete" | "context";

export interface NormalizedLine {
  type: DiffLineType;
  content: string;
}

export function normalizeLine(
  raw: string,
  type: DiffLineType,
): NormalizedLine {
  const content = raw
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .trimEnd();

  return { type, content };
}

export function canonicalizePatch(lines: NormalizedLine[]): string {
  const prefixMap: Record<DiffLineType, string> = {
    add: "+",
    delete: "-",
    context: " ",
  };

  return lines
    .map((line) => `${prefixMap[line.type]}${line.content}`)
    .join("\n");
}

function fnv1a32(input: string): number {
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;

  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

export function computePatchHash(lines: NormalizedLine[]): string {
  const canonical = canonicalizePatch(lines);
  const hash = fnv1a32(canonical);
  return `fnv:${hash.toString(16).padStart(8, "0")}`;
}
