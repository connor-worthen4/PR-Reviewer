/**
 * Unified diff parser.
 * Converts file line numbers to GitHub review API "position" values.
 *
 * The GitHub "Create a review" API requires `position` (1-based offset from
 * the @@ hunk header counting every line), NOT the source file line number.
 */

/**
 * Parse a unified diff into position maps per file.
 * @returns {{ [filePath]: { lineToPosition: {[line]: position}, validPositions: Set<number> } }}
 */
function parseDiffPositions(diff) {
  const files = {};
  let currentFile = null;
  let position = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    const fileMatch = raw.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!files[currentFile]) {
        files[currentFile] = { lineToPosition: {}, validPositions: new Set() };
      }
      position = 0;
      continue;
    }

    if (raw.startsWith("--- ")) continue;

    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentFile) continue;
    if (raw.startsWith("diff ") || raw.startsWith("index ") ||
        raw.startsWith("Binary ") || raw.startsWith("\\")) {
      continue;
    }

    position++;

    if (raw.startsWith("+")) {
      files[currentFile].lineToPosition[newLine] = position;
      files[currentFile].validPositions.add(position);
      newLine++;
    } else if (raw.startsWith("-")) {
      files[currentFile].validPositions.add(position);
    } else {
      files[currentFile].lineToPosition[newLine] = position;
      files[currentFile].validPositions.add(position);
      newLine++;
    }
  }

  return files;
}

/**
 * Map a source line number to a diff position.
 * Falls back to the closest available line if the exact line isn't in the diff.
 */
function lineToPosition(file, targetLine, diffData) {
  const fileData = diffData[file];
  if (!fileData) return null;

  const map = fileData.lineToPosition;
  if (map[targetLine]) return map[targetLine];

  const lines = Object.keys(map).map(Number);
  if (lines.length === 0) return null;

  let closest = lines[0];
  let minDist = Math.abs(targetLine - closest);

  for (const line of lines) {
    const dist = Math.abs(targetLine - line);
    if (dist < minDist) {
      minDist = dist;
      closest = line;
    }
  }

  return map[closest];
}

module.exports = { parseDiffPositions, lineToPosition };
