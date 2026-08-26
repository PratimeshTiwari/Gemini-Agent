import { select } from '@inquirer/prompts';

async function run() {
  const role = await select({
    message: 'Select Role to Configure:',
    choices: [
      { name: 'Main Agent', value: 'main' },
      { name: 'Reviewer Subagent', value: 'reviewer' },
      { name: 'Reasoner Subagent', value: 'reasoner' }
    ]
  });
  const model = await select({
    message: `Select Model for ${role}:`,
    choices: [
      { name: 'Google Gemini', value: 'gemini' },
      { name: 'ChatGPT', value: 'chatgpt' },
      { name: 'Claude', value: 'claude' }
    ]
  });
  console.log({ role, model });
}
run();
