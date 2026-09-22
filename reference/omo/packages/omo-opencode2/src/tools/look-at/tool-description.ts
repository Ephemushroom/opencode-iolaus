export const LOOK_AT_DESCRIPTION = [
  "Extract information from a media file (image, diagram, PDF) when the current model cannot see images.",
  "",
  "If the current model already accepts image input, this tool tells you to use `read` instead:",
  "`read` renders media directly and costs one call rather than a delegated session.",
  "If the current model is blind to images, the file is examined by a vision-capable model",
  "and you get back its findings as text.",
  "",
  "State a concrete goal. The looking model returns only what the goal asks for,",
  "so a vague goal wastes the round trip.",
].join("\n")
