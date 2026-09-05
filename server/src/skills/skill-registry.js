/**
 * Skill Registry
 * 
 * Manages the registration, retrieval, and execution of agent skills.
 */
export class SkillRegistry {
  constructor() {
    this.skills = new Map();
  }

  /**
   * Register a new skill.
   * @param {import('./skill.js').Skill} skill
   */
  register(skill) {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill with name '${skill.name}' is already registered`);
    }
    this.skills.set(skill.name, skill);
  }

  /**
   * Check if a skill exists.
   * @param {string} name 
   * @returns {boolean}
   */
  hasSkill(name) {
    return this.skills.has(name);
  }

  /**
   * Execute a skill by name.
   * @param {string} name 
   * @param {Object} args 
   * @param {Object} context 
   * @returns {Promise<any>}
   */
  async execute(name, args, context) {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill '${name}' not found`);
    }

    try {
      return await skill.execute(args, context);
    } catch (err) {
      throw new Error(`[Skill: ${name}] ${err.message}`);
    }
  }

  /**
   * Get all registered skills formatted for injection into the prompt.
   * @returns {Array<Object>}
   */
  getAllSkillDefinitions() {
    return Array.from(this.skills.values()).map(skill => skill.toJSON());
  }

  /**
   * Return markdown documentation of available skills.
   * @returns {string}
   */
  getMarkdownDefinitions() {
    let md = '';
    for (const skill of this.skills.values()) {
      md += `## ${skill.name}\n`;
      md += `${skill.description}\n`;
      md += `Parameters:\n`;
      for (const [paramName, paramConfig] of Object.entries(skill.parameters.properties || {})) {
        const requiredStr = (skill.parameters.required || []).includes(paramName) ? 'required' : 'optional';
        md += `  - ${paramName} (${paramConfig.type}, ${requiredStr}): ${paramConfig.description}\n`;
      }
      md += '\n';
    }
    return md.trim();
  }
}
