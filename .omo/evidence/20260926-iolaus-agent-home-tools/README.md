# Agent home: skills loading and memory tools

## WHAT WAS TESTED

- `src/home-skills.ts`: `agent/skills/<name>/SKILL.md` (user) and
  `.iolaus/skills/<name>/SKILL.md` (project) parsed (frontmatter name/
  description, folder name fallback, invalid names skipped, project shadows
  user) and added through `skill.transform` as `iolaus-home:<name>`; a host
  skill owning the id is left alone.
- `src/home-memory.ts`: Code Mode namespace `memory` with `list`/`read`
  (permission `read`) and `write`/`remove` (permission `memory`). Notes are
  `<slug>.md` under `agent/memory` (user) or `.iolaus/memory` (project);
  kebab-case slugs, 64 KiB cap, paths confined to the layer directory.
  `registration.ts` grants `memory` to sisyphus, hephaestus, prometheus,
  atlas, metis; prometheus may also edit `agent/plans`. The `<iolaus-home>`
  contract tells agents to read notes before re-investigating and write
  durable facts.
- `bun test` 79 pass (3 new), typecheck, build, check:reference, check:package.
- Real OpenCode 2.0.16 isolated QA, 28 checks:
  `.omo/evidence/20260926-iolaus-agent-home-tools/`.

## WHAT WAS OBSERVED

- All 28 passed. `home-memory` (iolaus-sisyphus, registered permissions):
  one `execute` wrote `qa-note` to the user layer, read it back
  (`IOLAUS_HOME_NOTE`), listed it; the file exists under the sandbox
  `home/.iolaus/agent/memory/qa-note.md`; `iolaus.memory.call {tool: write,
  ok: true, agent: iolaus-sisyphus}`. The QA `qa-skill` under the sandbox
  user layer was registered (`iolaus.home.skills {registered:
  ["iolaus-home:qa-skill"]}`) and appeared in the system prompt skill list
  with its description.
- `home-memory-readonly` (iolaus-explore): `tools.memory.list` worked;
  `tools.memory.write` threw `Unknown tool 'memory.write'` (the host hides
  denied tools from the Code Mode catalog); no write trace.
- Earlier scenarios unchanged. Isolation, cleanup, mock protocol passed.

## WHY IT IS ENOUGH

Skill loading is proven by the host advertising the skill; memory by a real
round trip through Code Mode plus the file on disk; the permission asymmetry
by the host's own catalog hiding. Slug/size/path validation is unit-tested.

## KNOWN LIMITS

- Skills are loaded at plugin setup; adding a SKILL.md needs a plugin
  reload. Memory notes are read on each call, so edits are live.
