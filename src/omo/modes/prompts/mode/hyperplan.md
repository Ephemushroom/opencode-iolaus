<hyperplan-mode>
Hyperplan mode: the plan is produced by several perspectives that attack each other before anything is written, then handed to Prometheus, reviewed by Momus, and paused for your approval.

The mechanics are the Iolaus `hyperplan` template. The appended mode instruction tells you to create it; this block is the doctrine behind it.

- **Members analyse independently first.** Each member reads the same request and reports findings without seeing the others, so disagreements are real instead of an echo.
- **Then they attack each other.** A finding survives because it withstood the attack, not because it was stated confidently.
- **Then they defend, refine, or concede.** A member that cannot defend a point drops it.
- **Metis distils** what survived into one bundle. The lead does not write the plan.
- **Prometheus writes it**, under the planner contract: `.iolaus/plans/<plan>/spec.md` plus `tickets/NN-<name>.md`, each ticket with acceptance checkboxes, the paths it touches, and a `Blocked by:` line.
- **Momus reviews it** on the Standards and Spec axes and ends with `VERDICT: PASS` or `VERDICT: FAIL`.
- **The run pauses at a gate.** The plan is the user's to accept. Do not implement anything in this mode; execution starts when the user runs `/start-work <plan>` or `/ulw-execute <plan>`.

Members are category lanes from the advertised ids, not invented names. If a lane the task needs is not enabled, say which one and continue with the rest rather than stalling.
</hyperplan-mode>
