import type { LiveSkill } from "./sisyphus-context"

interface SystemPartLike {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

export function injectSkillCatalogSystemPart(
  system: readonly SystemPartLike[],
  skills: readonly LiveSkill[],
): SystemPartLike[] {
  const retained = system.filter((part) => !part.text?.includes("<available-skills>"))
  if (skills.length === 0) return retained

  const entries = skills
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((skill) => `- ${skill.name}: ${skill.description ?? ""}`)
    .join("\n")

  return [
    ...retained,
    {
      type: "text",
      text: `<available-skills>\n${entries}\n</available-skills>`,
    },
  ]
}
