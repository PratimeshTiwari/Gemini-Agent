import { recall } from '../../core/session-recall.js';

/**
 * Search this conversation's own past, including what compaction dropped.
 *
 * The model cannot see turns a summary replaced. This is how it gets them back
 * without anyone having to decide in advance what would matter.
 */
export default {
  name: 'recall_history',
  description:
    'Search earlier turns of this conversation, including ones a summary replaced and that you '
    + 'can no longer see. Use it when the context mentions a decision, a filename, an error or a '
    + 'preference you no longer have the detail of — rather than asking the user to repeat it, or '
    + 'guessing. Matching is literal and case-insensitive, so search for the exact term: a '
    + 'filename, an error code, a library name.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The exact term to look for' },
      limit: { type: 'number', description: 'How many matches to return (default 5, max 10)' },
    },
    required: ['query'],
  },
  async execute(args, context) {
    const workspace = context?.workspace || process.cwd();
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 10);
    const { total, shown } = recall(workspace, args?.query, { limit });

    if (total === 0) {
      return {
        result: `Nothing in this conversation's history mentions "${args?.query}". `
          + 'It may never have been said, or it may be worth asking the user.',
      };
    }

    const lines = shown.map((hit) => {
      const when = hit.when ? new Date(hit.when).toLocaleString() : 'unknown time';
      const from = hit.archived ? 'summarised away' : 'still in context';
      return `[${when} · ${hit.role} · ${from}]\n${hit.excerpt}`;
    });

    return {
      result: `${total} earlier turn${total === 1 ? '' : 's'} mention "${args?.query}"`
        + `${total > shown.length ? `, showing the ${shown.length} most recent` : ''}:\n\n`
        + lines.join('\n\n'),
    };
  },
};
