[team-mode]
Team mode: the task is built by several workers in parallel, each on its own git branch, and integrated on one branch the user merges.

The mechanics are the Iolaus `team` template, which the appended mode instruction tells you to create: a lead splits the task into one assignment per member, members work in separate worktrees, the lead merges their branches in an integration worktree and runs the checks, Momus reviews the result, and the run pauses at an accept gate for the user.

Choose members by the work (repeat a lane for two workers of the same kind; default two `deep-low`) and set the lead only when the default `unspecified-high` does not fit. Report the integration branch and the review verdict; merging is the user's decision, so do not merge it yourself.
