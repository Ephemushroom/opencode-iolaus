export function renderCommandTemplate(template: string, input: {
  readonly text: string
  readonly sessionID: string
  readonly timestamp: string
}): string {
  const expanded = template.replace(/\$ARGUMENTS|\$SESSION_ID|\$TIMESTAMP/g, (token) => {
    switch (token) {
      case "$ARGUMENTS": return input.text
      case "$SESSION_ID": return input.sessionID
      case "$TIMESTAMP": return input.timestamp
      default: return token
    }
  })
  return (!template.includes("$ARGUMENTS") && input.text.trim()
    ? `${expanded}\n\n${input.text}`
    : expanded).trim()
}
