import { PromptBuilder } from './server/src/prompt-builder.js';

const pb = new PromptBuilder('/Users/pratimesh/Documents/Gemini-Agent', '/Users/pratimesh/Documents/Gemini-Agent/server');
const prompt = pb.buildPrompt({ userMessage: 'list files', mode: 'plan', topology: 'single' });
console.log("PROMPT LENGTH:", prompt.length);
console.log("PROMPT STARTS WITH:\n", prompt.substring(0, 100));
console.log("\nPROMPT ENDS WITH:\n", prompt.substring(prompt.length - 100));
