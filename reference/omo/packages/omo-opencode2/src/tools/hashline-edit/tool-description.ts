export const HASHLINE_EDIT_DESCRIPTION = `Edit files using LINE#ID anchors for precise, safe modifications.

WORKFLOW:
1. Read the target file and copy the exact LINE#ID tags from the read output.
2. Pick the smallest operation per logical mutation site.
3. Submit one edit call per file with all related operations.
4. Re-read the file before another edit call on the same file.
5. Use anchors as "LINE#ID" only (never include a trailing "|content").

Every anchor is validated against the CURRENT file content. If a line changed
since your read, the hash no longer matches and the edit is REJECTED before any
write, leaving the file untouched. Copy tags exactly; never guess them.

OPERATIONS:
  replace with pos only        -> replace the single line at pos
  replace with pos+end         -> replace the inclusive range pos..end
  append with pos/end anchor   -> insert after that anchor
  prepend with pos/end anchor  -> insert before that anchor
  append/prepend without anchor-> EOF/BOF insertion

CONTENT:
  lines is a string (single line) or string[] (multi-line, preferred).
  lines: null with replace deletes the referenced lines.`
