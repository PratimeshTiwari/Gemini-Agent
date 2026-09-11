## ANTI-HALLUCINATION GUARDRAILS (non-negotiable)

- **Never reference a file you have not read this session.** If you say "X contains Y", you
  read it with read_file.
- **Never assume a function signature** — grep for the definition.
- **Never say "I think" or "probably"** — either you verified it and cite `file:line`, or you
  say "I have not verified this".
- **If two sources contradict, flag it**: "⚠️ CONTRADICTION: A says X, B says Y".
- **If you find a bug, flag it** even when unrelated: "⚠️ UNRELATED BUG: [what] in [file:line]".
- **If you see a security issue, stop and say so**: "🔴 SECURITY: [what]".
