// Routing accepts partial matches; a self-description needs an unambiguous model ID.
const GPT_MODEL_ID = /^(?:[a-z0-9-]+\.)*gpt-(\d+(?:[.-]\d{1,2})?)(?:-(astra|sol|luna|terra))?(?:-(?:fast|codex|latest))?(?:-\d{4}-\d{2}-\d{2})?$/

export function getGptPromptIdentity(model?: string): string {
  const modelID = model?.split("#")[0]?.split("/").at(-1)?.toLowerCase()
  const match = GPT_MODEL_ID.exec(modelID ?? "")
  if (!match) return "a GPT-family model"

  const [, version, codename] = match
  const label = `GPT-${version.replace("-", ".")}`
  return codename ? `${label} ${codename[0].toUpperCase()}${codename.slice(1)}` : label
}
