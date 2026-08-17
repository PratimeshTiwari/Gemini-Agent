# Gemini Agent Learnings & Observations

This file tracks repetitive mistakes, recurring patterns, and user preferences observed during our sessions.
In the future, we can convert these items into permanent "Skills" or system rules.

## User Preferences
- Only use Gemini Web for now.
- Keep the agent purely local.
- The UI should be available in both the Chrome Side Panel and the Terminal CLI.
- Provide ONE single answer per turn, no drafts or A/B testing prompts.

## Known Bugs / Gotchas
- Gemini's internal rich text editor requires `ClipboardEvent('paste')` to properly ingest text via content scripts. Modifying `innerHTML` breaks it.
- Sending a massive system prompt on every turn can trigger Gemini's safety/repetitive filters and A/B test modals. System instructions are now sent only on the first turn or after compaction.
- The DOM selectors for Gemini change occasionally. `extractLatestResponse` must wait for a *new* block to appear before grabbing the text to avoid race conditions.

## Repetitive Tasks to Automate
*(None yet)*

---
*Note: The agent can read and update this file when asked to "note this down" or "remember this".*
