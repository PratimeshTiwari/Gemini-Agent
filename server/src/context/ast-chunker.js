import * as acorn from 'acorn';

/**
 * ASTChunker
 * 
 * Uses Acorn (pure JS parser) to parse Javascript files and return only
 * requested functions or classes to save context tokens.
 */
export class ASTChunker {
  /**
   * Parse a JS file and extract specific function/class definitions.
   * @param {string} code - The source code
   * @param {string} targetName - Function or class name to extract
   * @returns {string|null} - The chunk of code, or null if not found
   */
  static extractChunk(code, targetName) {
    try {
      const ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true // capture line/column numbers
      });

      let foundNode = null;

      // Extremely basic AST walk for standard function/class declarations
      // A more robust implementation would use a proper AST traverser (like acorn-walk)
      for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id && node.id.name === targetName) {
          foundNode = node;
          break;
        }
        if (node.type === 'ClassDeclaration' && node.id && node.id.name === targetName) {
          foundNode = node;
          break;
        }
        // Export named declarations
        if (node.type === 'ExportNamedDeclaration' && node.declaration) {
          const dec = node.declaration;
          if ((dec.type === 'FunctionDeclaration' || dec.type === 'ClassDeclaration') && dec.id && dec.id.name === targetName) {
            foundNode = node; // capture the whole export block
            break;
          }
        }
      }

      if (foundNode) {
        // We can extract exactly the string slice using start/end if available.
        // Acorn nodes have start and end properties.
        return code.slice(foundNode.start, foundNode.end);
      }

      return null;
    } catch (err) {
      console.error('[ASTChunker] Parse error:', err.message);
      return null;
    }
  }
}
