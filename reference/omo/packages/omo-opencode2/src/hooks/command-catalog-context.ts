export interface LiveCommand {
  readonly name: string
  readonly description?: string
}

interface SystemPartLike {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

export function injectCommandCatalogSystemPart(
  system: readonly SystemPartLike[],
  commands: readonly LiveCommand[],
): SystemPartLike[] {
  const retained = system.filter((part) => !part.text?.includes("<available-slash-commands>"))
  if (commands.length === 0) return retained

  const entries = commands
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((command) => `- /${command.name}: ${command.description ?? ""}`)
    .join("\n")

  return [
    ...retained,
    {
      type: "text",
      text: `<available-slash-commands>\n${entries}\n</available-slash-commands>`,
    },
  ]
}
