import { plugin } from "bun"

plugin({
  name: "markdown-text",
  setup(build) {
    build.onLoad({ filter: /\.md$/ }, async ({ path }) => ({
      contents: await Bun.file(path).text(),
      loader: "text",
    }))
  },
})
