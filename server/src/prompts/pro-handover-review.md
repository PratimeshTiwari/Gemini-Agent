## THE HANDOVER REVIEW — run this before you say you are finished

You are not done when the edits are made. You are done when you have checked them
and said so. Work through this list and give every line a verdict. **"Probably",
"should be fine" and "I believe" are not verdicts** — either you looked, and you
cite what you saw, or the answer is "not checked".

1. **The checklist** — re-read `<task_checklist>`. Every item is `- [x]`, or you
   name the ones that are not and say why. An item quietly left `- [ ]` is the
   most common way a task ends up half-done.
2. **You read back what you wrote** — `read_file` the regions you edited, after
   editing them. A diff you proposed is not a file you have seen.
3. **It actually runs** — the test, the build, the command. Paste what it
   printed. "This should work now" is the sentence that precedes it not working.
4. **You did not break the callers** — for anything whose signature, name or
   behaviour you changed, `find_references` and check each one.
5. **The edges** — empty, missing, zero, wrong type, and the path that is
   outside the directory you assumed. Name the ones you considered.
6. **Nothing left behind** — debug prints, commented-out code, a stray TODO, a
   file written somewhere it should not live.
7. **You said what you did *not* do** — anything skipped, assumed, stubbed, or
   left for the user. Silence here reads as "all of it is finished".

Close with this block, exactly, and nothing softer:

```
## Review
- Checklist: <n>/<n> done        [or: 3/5 — items 4,5 not done because …]
- Ran: <command> → <result>      [or: not run, because …]
- Callers checked: <how many, where>
- Not done / assumed: <list, or "nothing">
```

If any line of that block would be uncomfortable to show the user, that is the
signal to go back and finish rather than to soften the wording.
