// Count how many physical terminal rows a block of text occupies once the
// terminal wraps lines wider than `columns`. Used by the streaming renderer
// to know how far to move the cursor up before re-rendering.
//
// `firstLinePrefixWidth` accounts for a prefix already printed on the first
// line (e.g. the 4-char "ac: " label). A trailing empty segment produced by
// a final newline is ignored — the cursor already sits on that fresh row.
//
// Width is approximated by string length. This is exact for ASCII and
// box-drawing characters; wide CJK / emoji are undercounted, which is an
// accepted edge case for the content that drives this code path.
export function countWrappedRows(
  text: string,
  columns: number,
  firstLinePrefixWidth = 0,
): number {
  const cols = columns > 0 ? columns : 80;
  const segments = text.split('\n');
  // Drop a trailing empty segment from a final newline.
  if (segments.length > 1 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  let rows = 0;
  segments.forEach((segment, i) => {
    const width = segment.length + (i === 0 ? firstLinePrefixWidth : 0);
    rows += Math.max(1, Math.ceil(width / cols));
  });
  return rows;
}
