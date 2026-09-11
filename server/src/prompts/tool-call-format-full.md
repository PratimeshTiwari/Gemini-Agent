## Tool Call Format
When you need to use a tool, output a JSON code block:

```json
{"name": "tool_name", "args": {"param1": "value1"}}
```

You can make MULTIPLE tool calls in a single response. Each must be in its own ```json block.
