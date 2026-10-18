#!/bin/sh
set -eu
: "${QA_OPENCODE_SOURCE:=/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/owner-rescue-opencode-2.0.27}"
: "${OPENCODE_TEST_HOME:?Set OPENCODE_TEST_HOME to an isolated sandbox home}"
: "${QA_SANDBOX:?Set QA_SANDBOX to the marked isolated sandbox}"
test "$QA_SANDBOX" != /
test -f "$QA_SANDBOX/.inbox-qa-sandbox"
test "$HOME" = "$OPENCODE_TEST_HOME"
: "${XDG_CONFIG_HOME:?Set isolated XDG_CONFIG_HOME}"
: "${XDG_DATA_HOME:?Set isolated XDG_DATA_HOME}"
: "${XDG_CACHE_HOME:?Set isolated XDG_CACHE_HOME}"
: "${XDG_STATE_HOME:?Set isolated XDG_STATE_HOME}"
: "${IOLAUS_HOME:?Set isolated IOLAUS_HOME}"
for path in "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$IOLAUS_HOME"; do
  case "$path" in
    "$QA_SANDBOX"/*) ;;
    *) echo 'All state paths must be inside QA_SANDBOX' >&2; exit 2 ;;
  esac
done
case "${1:-}" in
  serve|--version|--help) ;;
  *) echo 'Sandbox wrapper permits only explicit serve, --version, or --help' >&2; exit 2 ;;
esac
exec bun --preload "$QA_OPENCODE_SOURCE/packages/cli/node_modules/@opentui/solid/scripts/preload.js" \
  --tsconfig-override "$QA_OPENCODE_SOURCE/packages/cli/tsconfig.json" \
  "$QA_OPENCODE_SOURCE/packages/cli/src/index.ts" "$@"
