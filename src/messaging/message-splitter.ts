/**
 * Smart message splitting for WeChat's 4000-char limit.
 *
 * Strategy:
 * 1. Split at paragraph boundaries (double newlines)
 * 2. For oversized single blocks, try: newline > sentence-ending punctuation > space > hard cut
 * 3. Each split point must be at least 30% into the max length to avoid tiny fragments
 *
 * Ported from wechat-claude-code-enhanced (MIT).
 */

const MAX_CHARS = 4000;
const MIN_SPLIT_RATIO = 0.3; // Don't split before 30% of max length

/**
 * Split a long message into chunks that fit within WeChat's character limit.
 * Preserves markdown structure where possible.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_CHARS) {
    const splitPoint = findBestSplitPoint(remaining, MAX_CHARS);
    chunks.push(remaining.slice(0, splitPoint).trimEnd());
    remaining = remaining.slice(splitPoint).trimStart();
  }

  if (remaining.trim()) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Find the best position to split text, preferring natural break points.
 */
function findBestSplitPoint(text: string, maxLen: number): number {
  const minSplit = Math.floor(maxLen * MIN_SPLIT_RATIO);

  // 1. Try paragraph boundaries (double newline)
  const paraSplit = findLastOccurrence(text, "\n\n", maxLen, minSplit);
  if (paraSplit > 0) return paraSplit;

  // 2. Try single newlines
  const newlineSplit = findLastOccurrence(text, "\n", maxLen, minSplit);
  if (newlineSplit > 0) return newlineSplit;

  // 3. Try sentence-ending punctuation (. ! ? 。！？)
  const sentenceSplit = findLastPattern(text, /[.!?。！？]\s/g, maxLen, minSplit);
  if (sentenceSplit > 0) return sentenceSplit;

  // 4. Try commas and other pauses (, ; ，；)
  const commaSplit = findLastPattern(text, /[,;，；]\s/g, maxLen, minSplit);
  if (commaSplit > 0) return commaSplit;

  // 5. Try spaces
  const spaceSplit = findLastOccurrence(text, " ", maxLen, minSplit);
  if (spaceSplit > 0) return spaceSplit;

  // 6. Hard cut at max length
  return maxLen;
}

/**
 * Find the last occurrence of a string within a range.
 */
function findLastOccurrence(text: string, search: string, maxPos: number, minPos: number): number {
  const idx = text.lastIndexOf(search, maxPos);
  return idx >= minPos ? idx + search.length : 0;
}

/**
 * Find the last match of a regex pattern within a range.
 */
function findLastPattern(text: string, pattern: RegExp, maxPos: number, minPos: number): number {
  let lastMatch = 0;
  let match: RegExpExecArray | null;

  // Reset regex state
  pattern.lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index >= maxPos) break;
    if (match.index >= minPos) {
      lastMatch = match.index + match[0].length;
    }
  }

  return lastMatch;
}
