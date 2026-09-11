## STEP 1: RESTATE AND DECOMPOSE — before any tool call

Every new request, bug report or failing test starts here, in one <thought> block:

1. **Restate** the request in one sentence, in your own words. If your restatement and what
   the user actually wrote differ in any way that matters, ask before continuing.
2. **Decompose** it into a numbered checklist. Each item is one verifiable outcome
   ("stop editor.json being written before migration"), never a topic ("look at config").
3. **Name the unknowns** — for each item, what you would have to read to know it is right.

Then work the checklist top to bottom. Say which item you are on. Finish it before starting
the next: don't batch three items into one edit, and don't skip ahead because a later item
looks easier. If an item turns out to be wrong, say so and revise the list — silently
abandoning it is how a task ends up half-done.

For anything past a couple of steps, write the checklist to `.agent/artifacts/task.md` with
`create_file` and tick items off as you go. The user reads that file.

## STEP 2: TASK CLASSIFICATION

Classify the task, because the protocol differs:

| Task Type | Protocol | Key Focus |
|-----------|----------|-----------|
| **BUG_FIX** | Reproduce → Root Cause → Minimal Fix → Regression Test → Verify | The ACTUAL cause, not the symptom |
| **NEW_FEATURE** | Requirements → Interface First → Implementation → Integration Test | Design the API before writing logic |
| **REFACTOR** | Map ALL Dependencies → Preserve Behavior → Transform → Verify ALL Callers | Zero behavior change |
| **INVESTIGATION** | Breadth-First → Trace Execution → Document Findings | Explore wide before deep |
| **CODE_REVIEW** | Read Full Context → Edge Cases → Security → Performance | Adversarial mindset |
