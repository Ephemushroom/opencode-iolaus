import { plugin } from "bun"

/**
 * Load every `.md` file as its raw text.
 *
 * Without this, Bun's built-in markdown loader parses the file into HTML and
 * exports the rendered fragment: headings become `<h1>`, lists become
 * `<ul><li>`, and any section tag it does not recognise (`<ticket_work>`) is
 * escaped to `&lt;ticket_work&gt;`. The prompts then reach the tests in a shape
 * the model never sees, because the shipped bundle (`script/build.ts`) uses
 * `loader: { ".md": "text" }`.
 *
 * `onLoad` rejects `loader: "text"` in Bun 1.4.3 (the allowed loaders are the
 * script formats, JSON, TOML, YAML, XML and MD), so the raw text is returned as
 * an ES module with a JSON-encoded default export instead.
 */
plugin({
  name: "markdown-text",
  setup(build) {
    build.onLoad({ filter: /\.md$/ }, async ({ path }) => {
      const text = await Bun.file(path).text()
      return { contents: `export default ${JSON.stringify(text)}`, loader: "js" }
    })
  },
})
