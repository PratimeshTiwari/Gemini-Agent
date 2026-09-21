## Tool Call Format
When you need to use a tool, output a JSON code block:

```json
{"name": "tool_name", "args": {"param1": "value1"}}
```

You can make MULTIPLE tool calls in a single response. Each must be in its own ```json block.

### A tool call and a conclusion cannot be in the same reply

If you emit a tool call, that reply asks a question. Stop there. A `<thought>`
block planning the call is fine; an answer, a summary or a `## Review` block is
not, because you are writing it before the results exist.

The results come back as `<tool_results>` in the next turn. Conclude then, from
what they say. If the answer is already clear and you need nothing, emit no tool
call and answer — but do not do both.
