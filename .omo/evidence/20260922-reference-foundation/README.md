# Reference foundation verification

## What was tested

`node script/check-reference.mjs` hashed the complete offline retained source inventory, compared every hash with source commit `598cb66580bebaf39c5ea20ee4bef6cb7a906777`, and checked for untracked additions, symlinks, and active historical AGENTS.md filenames.

`gh repo view Ephemushroom/opencode-iolaus --json nameWithOwner,isFork,parent,visibility,defaultBranchRef` verified the new repository identity.

## What was observed

- 800 reference files, 3,339,189 bytes, all hashes PASS.
- GitHub repository is PUBLIC, `isFork=false`, `parent=null`, default branch `dev`.
- The source repository has not been modified. Iolaus starts from an independent empty root commit.
- This commit has no runtime plugin; no host was launched or user configuration accessed.

## Why sufficient

This change preserves historical source and establishes ownership only. Hash equality covers reference fidelity; GitHub metadata covers independence. Runtime loading and prompt behavior are the next delivery unit and require live sandbox QA.

## What was omitted

No credentials, environment dumps or private files were captured. The snapshot contains only the explicitly selected git-tracked source files.
