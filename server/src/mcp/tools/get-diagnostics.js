import fs from 'fs/promises';
import { diagnosticsPath } from '../../core/paths.js';

/** Beyond this the list stops being useful and starts being a token bill. */
const MAX_REPORTED = 40;

/**
 * Tool: get_diagnostics
 *
 * The Problems panel, as the agent sees it.
 *
 * This is the cheapest real signal the editor has: the language server has
 * already type-checked, linted and parsed every open file, and the agent would
 * otherwise have to run a build to learn the same thing — slower, and it only
 * covers what the build touches. It is also the fastest way to check its own
 * work: make an edit, read the diagnostics, see whether it broke anything.
 */
export default {
  name: 'get_diagnostics',
  description:
    "Read the editor's current errors and warnings (the VS Code Problems panel) for the "
    + 'workspace. Use it after editing a file to check the change compiles and lints, and '
    + 'before starting work to see what is already broken. Requires the VS Code companion '
    + "extension. Optionally filter to one file with 'path', or to errors only with "
    + "'severity: \"error\"'.",
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Only report problems for this file (workspace-relative or absolute).',
      },
      severity: {
        type: 'string',
        description: "Lowest severity to report: 'error', 'warning' (default), 'info'.",
      },
    },
    required: [],
  },

  async execute(args = {}, context = {}) {
    const workspace = context.workspace || process.cwd();
    let payload;

    try {
      payload = JSON.parse(await fs.readFile(diagnosticsPath(workspace), 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          error: 'No diagnostics available. This needs the Agent CLI VS Code companion '
            + 'extension installed with this workspace open. Run a build or the type checker '
            + 'with run_command instead.',
        };
      }
      return { error: `Failed to read diagnostics: ${err.message}` };
    }

    const age = Date.now() - (payload.timestamp || 0);
    // Five minutes is the same staleness bar get_editor_state uses.
    const stale = age > 300000;

    const rank = { error: 0, warning: 1, info: 2, hint: 3 };
    const floor = rank[String(args.severity || 'warning').toLowerCase()] ?? rank.warning;

    let problems = Array.isArray(payload.problems) ? payload.problems : [];
    if (args.path) {
      const needle = String(args.path).replace(/^\.\//, '');
      problems = problems.filter((p) => p.file?.includes(needle));
    }
    problems = problems.filter((p) => (rank[p.severity] ?? 3) <= floor);

    if (problems.length === 0) {
      return {
        result: stale
          ? 'No problems reported, but the editor state is stale — VS Code may be closed.'
          : 'No problems reported by the editor.',
      };
    }

    // Errors first: a warning under an error is usually a consequence of it.
    problems.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    const shown = problems.slice(0, MAX_REPORTED);
    const lines = shown.map(
      (p) => `${p.severity === 'error' ? '✗' : '⚠'} ${p.file}:${p.line}:${p.column} `
        + `${p.message}${p.source ? ` [${p.source}]` : ''}`,
    );

    const counts = problems.reduce((acc, p) => {
      acc[p.severity] = (acc[p.severity] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
    const omitted = problems.length - shown.length;

    return {
      result: [
        `${summary}${stale ? ' (editor state is stale)' : ''}:`,
        ...lines,
        omitted > 0 ? `… and ${omitted} more` : '',
      ].filter(Boolean).join('\n'),
    };
  },
};
