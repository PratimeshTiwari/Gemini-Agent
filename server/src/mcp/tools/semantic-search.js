export default {
  name: 'semantic_search',
  description: 'Search the workspace using a background RAG index. Finds code chunks conceptually related to your query, even if exact keywords don\'t match perfectly (uses TF-IDF). Returns the most relevant code chunks.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query or concept (e.g. "authentication logic", "database connection string")' },
      topK: { type: 'number', description: 'Number of results to return (default: 5)' }
    },
    required: ['query']
  },
  async execute(args, context) {
    if (!context.workspaceIndexer) {
      return { error: 'WorkspaceIndexer is not available or not initialized.' };
    }
    
    const results = context.workspaceIndexer.search(args.query, args.topK || 5);
    
    if (results.length === 0) {
      return { result: 'No matches found in the workspace index.' };
    }
    
    if (results[0].error) {
      return { error: results[0].error };
    }
    
    // Format nicely for the agent
    const formatted = results.map((r, i) => 
      `[Result ${i + 1}] File: ${r.file} (Lines: ${r.lines})\nRelevance Score: ${r.score}\n\`\`\`\n${r.content}\n\`\`\``
    ).join('\n\n---\n\n');
    
    return { result: formatted };
  }
};
