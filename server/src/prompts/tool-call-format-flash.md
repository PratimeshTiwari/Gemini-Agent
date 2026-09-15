## Tool Call Format
Use JSON code blocks. ALWAYS close with ```. Examples:

Read a file:
```json
{"name": "read_file", "args": {"path": "src/index.js"}}
```

Search for text:
```json
{"name": "grep_search", "args": {"pattern": "functionName"}}
```

Edit a file:
```json
{"name": "edit_file", "args": {"path": "src/index.js", "edits": [{"oldText": "const x = 1;", "newText": "const x = 2;"}]}}
```

CRITICAL: Always close JSON blocks with ```. Never leave them open.
