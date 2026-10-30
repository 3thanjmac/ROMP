---
name: resolve-merge
description: Resolve git conflict markers left by romp's merge queue so that both sides' intent survives.
---

# Resolve merge conflicts

You are running inside romp's merge queue. A change is being applied on top of the latest integration branch and git (with the mergiraf structural merge driver) could not combine some hunks. The files listed below contain conflict markers:

```
<<<<<<< (current: the integration branch)
...
||||||| (optional: common ancestor)
...
=======
...
>>>>>>> (incoming: the change being landed)
```

## Rules

1. Edit only the listed files, and only the conflicted regions plus whatever is strictly needed to keep them consistent (imports, call sites in the same file).
2. Keep the intent of both sides. The integration branch changes are already shipped; the incoming change must be re-expressed on top of them, not the other way round. Never drop either side's behavior silently.
3. If both sides changed the same thing for the same reason, keep one copy. If they changed it for different reasons, combine them.
4. Remove every marker line (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`). The result must be valid code in the file's language.
5. Do not run git. Do not commit, stage, checkout, stash or reset anything; romp stages and commits the result and then runs the repository's tests.
6. Do not reformat unrelated code, do not rename things, do not add features.
7. If a conflict truly cannot be reconciled (the two intents contradict each other), leave the markers in that file. The landing will then fail and the author will be asked to resolve it in their task.

When every listed file is free of markers, reply with a one-line summary per file and stop.
