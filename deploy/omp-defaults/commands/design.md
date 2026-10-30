---
description: Consult the designer model (Kimi K3) for a design brief, then implement it
---

Design consult, then implement: $ARGUMENTS

Do this in one turn, without asking me to confirm between steps.

1. Ground the request yourself first, and hand the grounding over. The designer is read-only, budgeted to one batch of reads, and blocks the turn, so anything you already read is free context for it and anything you skip costs it a round trip.
2. Dispatch the `designer` agent (designer model role, read-only, blocking). In the `task` field give it:
   - the request above, restated with the concrete file paths you found
   - the target file paths with line ranges worth reading, plus the reference surface you think it should mirror
   - verbatim excerpts of the tokens, component props, and data shape it would otherwise have to look up
   - which states and data conditions actually exist for that surface
   - screenshot paths for the current state if you have them, otherwise the URL of the surface on the running dev server so the designer can capture it itself
   Tell it to answer with its two-section contract only: `## Direction`, then one fenced implementation prompt. Do not ask for extra sections.
3. Implement the returned implementation prompt yourself. Follow it as a spec, but you own correctness: if it names a token, component, prop, or file that does not exist, or flags one `UNVERIFIED:`, or it conflicts with the repo's context files or RBAC/permission rules, fix the discrepancy and say so explicitly in your final message. Never invent design decisions the brief left open; ask the designer agent through `hub send` instead, it stays reachable after it yields.
4. Verify with the repo's own loop, then report: what you implemented, where you deviated from the brief and why, and anything you could not verify visually.
