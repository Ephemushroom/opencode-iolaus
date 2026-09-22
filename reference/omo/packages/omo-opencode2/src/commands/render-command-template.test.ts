import { expect, test } from "bun:test"
import { renderCommandTemplate } from "./render-command-template"

test("#given authored placeholders #when rendering #then values expand once and arguments stay literal", () => {
  // given
  const text = "$ARGUMENTS $SESSION_ID $TIMESTAMP $1 $& $$ !`touch forbidden`"
  const template = "$SESSION_ID|$TIMESTAMP|$ARGUMENTS|$TIMESTAMP|$ARGUMENTS"
  // when
  const rendered = renderCommandTemplate(template, { text, sessionID: "session-a", timestamp: "time-a" })
  // then
  expect(rendered).toBe(`session-a|time-a|${text}|time-a|${text}`)
})

test.each(["", " \n "])("#given empty arguments %j #when no argument placeholder exists #then nothing is appended", (text) => {
  // given / when
  const rendered = renderCommandTemplate(" fixture ", { text, sessionID: "s", timestamp: "t" })
  // then
  expect(rendered).toBe("fixture")
})

test("#given a template without an argument placeholder #when input is nonempty #then raw arguments append without expansion", () => {
  // given / when
  const rendered = renderCommandTemplate("context:$SESSION_ID", { text: " $SESSION_ID ", sessionID: "s", timestamp: "t" })
  // then
  expect(rendered).toBe("context:s\n\n $SESSION_ID")
})

test("#given an interior argument placeholder #when input has spaces #then input is not pre-trimmed", () => {
  // given / when
  const rendered = renderCommandTemplate("[$ARGUMENTS]", { text: " value ", sessionID: "s", timestamp: "t" })
  // then
  expect(rendered).toBe("[ value ]")
})
