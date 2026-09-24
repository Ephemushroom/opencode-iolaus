# Iolaus DAG TUI

## WHAT WAS TESTED

- `bun run typecheck`
- `bun run build`
- `bun test`
- `bun run check:package`
- Real OpenCode 2.0.15 `mini` TUI under tmux using a fully isolated HOME/XDG
  sandbox, a local package-shaped Iolaus install and a local config/plugin
  discovery entry.

## WHAT WAS OBSERVED

- TUI plugin trace emitted `iolaus.tui.loaded`.
- OpenCode mini booted and remained alive for the bounded smoke duration.
- The TUI plugin mounted through OpenCode CLI plugin discovery and used the
  compiled `dist/tui.js` entry.
- The sandbox was removed after shutdown.
- Real host config and database digests were identical before and after.
- Receipt: `receipt.json`.

## WHY IT IS ENOUGH

This proves the shipped TUI entry is loadable by the real OpenCode 2.0.15 host,
the plugin can mount through the native TUI plugin seam, and teardown does not
leak a process or modify host state. The DAG sidebar reads through the typed
Iolaus RPC contract; controller state and event delivery remain covered by the
DAG runtime tests and host DAG QA.

## WHAT WAS OMITTED

- This is a boot and mount smoke, not visual screenshot approval.
- The first panel does not yet expose interactive cancel/retry keybindings;
  those are the next TUI increment.
- No provider credentials or real model calls were used.
