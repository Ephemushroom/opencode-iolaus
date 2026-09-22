import { computeLineHash } from "@oh-my-opencode/hashline-core"

const COLON_READ_LINE_PATTERN = /^\s*(\d+): ?(.*)$/
const PIPE_READ_LINE_PATTERN = /^\s*(\d+)\| ?(.*)$/
const CONTENT_OPEN_TAG = "<content>"
const CONTENT_CLOSE_TAG = "</content>"
const FILE_OPEN_TAG = "<file>"
const FILE_CLOSE_TAG = "</file>"
const OPENCODE_LINE_TRUNCATION_SUFFIX = "... (line truncated to 2000 chars)"
const ALREADY_TAGGED_PATTERN = /^\s*\d+#[ZPMQVRWSNKTXJBYH]{2}\|/

interface ParsedReadLine {
  lineNumber: number
  content: string
}

function parseReadLine(line: string): ParsedReadLine | null {
  const colonMatch = COLON_READ_LINE_PATTERN.exec(line)
  if (colonMatch) {
    return { lineNumber: Number.parseInt(colonMatch[1], 10), content: colonMatch[2] }
  }
  const pipeMatch = PIPE_READ_LINE_PATTERN.exec(line)
  if (pipeMatch) {
    return { lineNumber: Number.parseInt(pipeMatch[1], 10), content: pipeMatch[2] }
  }
  return null
}

function tagLine(line: string): string {
  if (ALREADY_TAGGED_PATTERN.test(line)) {
    return line
  }
  const parsed = parseReadLine(line)
  if (!parsed) {
    return line
  }
  if (parsed.content.endsWith(OPENCODE_LINE_TRUNCATION_SUFFIX)) {
    return line
  }
  const hash = computeLineHash(parsed.lineNumber, parsed.content)
  return `${parsed.lineNumber}#${hash}|${parsed.content}`
}

function isNumberedReadLine(line: string): boolean {
  return ALREADY_TAGGED_PATTERN.test(line) || parseReadLine(line) !== null
}

function firstNumberedIndex(lines: string[]): number {
  return lines.findIndex((line) => isNumberedReadLine(line))
}

/**
 * Tags a contiguous run of numbered read lines. A leading header (for example
 * the v2 `read` tool's "Read file X, lines 1-3" line) and any trailing footer
 * (for example "(End of file...)") are preserved verbatim.
 */
function tagContiguousReadLines(lines: string[]): string[] {
  const start = firstNumberedIndex(lines)
  if (start === -1) {
    return lines
  }
  const result = lines.slice(0, start)
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (!isNumberedReadLine(line)) {
      result.push(...lines.slice(index))
      break
    }
    result.push(tagLine(line))
  }
  return result
}

/**
 * Rewrites an opencode `read` tool output string so each file line carries its
 * `LINE#ID` hash tag. Idempotent: a line already tagged is left untouched, so
 * repeated `execute.after` passes never double tag. Non-text payloads are
 * returned unchanged.
 */
export function tagReadOutput(output: string): string {
  if (!output) {
    return output
  }

  const lines = output.split("\n")
  const contentStart = lines.findIndex(
    (line) => line === CONTENT_OPEN_TAG || line.startsWith(CONTENT_OPEN_TAG),
  )
  const contentEnd = lines.indexOf(CONTENT_CLOSE_TAG)
  const fileStart = lines.findIndex((line) => line === FILE_OPEN_TAG || line.startsWith(FILE_OPEN_TAG))
  const fileEnd = lines.indexOf(FILE_CLOSE_TAG)

  const blockStart = contentStart !== -1 ? contentStart : fileStart
  const blockEnd = contentStart !== -1 ? contentEnd : fileEnd
  const openTag = contentStart !== -1 ? CONTENT_OPEN_TAG : FILE_OPEN_TAG

  if (blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart) {
    const openLine = lines[blockStart] ?? ""
    const inlineFirst =
      openLine.startsWith(openTag) && openLine !== openTag ? openLine.slice(openTag.length) : null
    const fileLines =
      inlineFirst !== null
        ? [inlineFirst, ...lines.slice(blockStart + 1, blockEnd)]
        : lines.slice(blockStart + 1, blockEnd)
    if (firstNumberedIndex(fileLines) === -1) {
      return output
    }

    const tagged = tagContiguousReadLines(fileLines)
    const prefixLines =
      inlineFirst !== null ? [...lines.slice(0, blockStart), openTag] : lines.slice(0, blockStart + 1)
    return [...prefixLines, ...tagged, ...lines.slice(blockEnd)].join("\n")
  }

  if (firstNumberedIndex(lines) === -1) {
    return output
  }

  return tagContiguousReadLines(lines).join("\n")
}
