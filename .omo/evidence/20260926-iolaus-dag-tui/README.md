# Iolaus DAG TUI: colours, activity, keybinds, open child session

## WHAT WAS TESTED

- `src/tui.tsx` rewritten: `sidebar.content` sidebar and `sidebar.footer`
  summary. Theme-coloured status glyphs, progress bar, generation/age, nodes
  ordered gates → running → rest and indented by dependency depth, `⚖` judge
  and `⏸` gate markers, gate prompt inline, running node's latest assistant
  text from `context.data.session.message`, keymap layer (`j`/`k`/`o`/`a`/`r`,
  palette retry/cancel), mouse select/open, `attention.notify` on
  `node.waiting`, toasts for action results. `src/tui/view.ts` holds the pure
  helpers (glyph, colour, progress, depth, ordering, summary, activity line,
  elapsed). `dagView` omits undefined fields.
- `bun test` 73 pass (3 new view tests), typecheck, build, `check:reference`,
  `check:package`; live DAG scenarios (`native`, `dag`, `route`, `template`)
  re-run green after the RPC output change.
- `script/qa-tui.mjs` rewritten: real OpenCode 2.0.16 TUI in tmux (160×45),
  sandbox HOME/XDG, local mock model. The user types a prompt; the model
  creates a plan-review template; children answer by role with small delays;
  Momus (judge) fails once then passes. Screens captured at idle, running,
  gate waiting, completed, opened child. Keys `Escape`, `a` (approve), then
  `j`/`o` to open a child session.

## WHAT WAS OBSERVED

- Verdict PASS. Screens in this directory (`01-idle` … `05-opened-child`).
- `02-running`: sidebar header, run line `▶ plan-review: IOLAUS_TUI_TASK`,
  progress `[░░░░░░░░░░░░] 0/6`, `▶ plan` running, pending nodes dimmed,
  footer `DAG · 1 run · 1 running`.
- `03-gate-waiting`: `⏸ approve ⏸` selected (auto-selected because it needs
  the user) with `gate: Plan for "IOLAUS_TUI_TASK" passed review. Approve to
  start execution or reject to stop.`, `✓ plan`, `✓ review ⚖`, `✓ revise`,
  `✓ rereview ⚖`, `· execute`, progress `4/6`, footer `1 waiting approval`,
  hint `j/k select · o open agent · a approve · r reject`.
- Pressing `a`: trace `iolaus.tui.action {action: approve, nodeID: approve}`
  → `node.approved` → `execute` ran → `run.completed`. `04-completed` shows
  `✓ approve ⏸` and `✓ execute`.
- Pressing `j` then `o` on `execute`: trace `iolaus.tui.open {nodeID: execute,
  sessionID: ses_…}`; `05-opened-child` shows the host switched to the child
  session titled `Iolaus DAG · execute` with the executor prompt and its
  `<iolaus-dag-inputs>` visible.
- Node order plan → review → revise → rereview → approve → execute; no momus
  child session (judge reviews). Real `~/.config/opencode/opencode.json` and
  the real database were unchanged (hash before == after); sandbox removed.
- Host facts learned: the sidebar mounts only inside a session (the home
  screen has no sidebar); RPC output is validated as JSON before the zod
  schema, so `undefined` fields must be omitted; `--print-logs` in the TUI
  floods the pane, so the QA runs without it.

## WHY IT IS ENOUGH

Every user-facing element is asserted on a captured screen of the real TUI,
and both interactions (approve via keybind, open child via keybind) are
proven by trace events that only the sidebar emits, followed by the host
state they caused (run completed; child session on screen).

## KNOWN LIMITS

- Per-node activity text depends on `context.data.session.message` being
  synced for child sessions; in this QA children finish in seconds so the
  captured screens show statuses rather than a mid-run activity line. The
  helper and wiring are unit-tested.
- Colours come from the host theme keys `success/warning/accent/error/
  textMuted`; a theme lacking a key falls back to the default text colour.
- Judge nodes have no session to open; `o` explains that in a toast.
