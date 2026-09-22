// Iolaus adaptation: prompt builders accept inline append text only. File access
// remains a host capability rather than an implicit prompt-builder side effect.
export function resolvePromptAppend(promptAppend: string): string {
  if (promptAppend.startsWith("file://")) {
    throw new TypeError("Iolaus prompt append accepts inline text; load files through OpenCode.")
  }
  return promptAppend
}
