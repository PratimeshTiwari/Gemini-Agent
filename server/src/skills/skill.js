/**
 * Base Skill Interface
 * 
 * All skills must extend this class and implement the `execute` method.
 */
export class Skill {
  /**
   * @param {Object} options
   * @param {string} options.name - The unique name of the skill (e.g. 'calculator')
   * @param {string} options.description - Detailed description for the LLM
   * @param {Object} options.parameters - JSON schema for the arguments
   */
  constructor({ name, description, parameters }) {
    if (!name || !description || !parameters) {
      throw new Error('Skill requires name, description, and parameters schema');
    }
    
    this.name = name;
    this.description = description;
    this.parameters = parameters;
  }

  /**
   * Execute the skill logic.
   * @param {Object} args - The arguments provided by the LLM
   * @param {Object} context - Execution context (e.g., workspace path)
   * @returns {Promise<any>} The result of the skill execution
   */
  async execute(args, context) {
    throw new Error(`Skill '${this.name}' must implement the execute method`);
  }

  /**
   * Serialize skill into a format suitable for Gemini's prompt / MCP.
   */
  toJSON() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }
}
