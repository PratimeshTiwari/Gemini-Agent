import { AgentLoop } from './src/agent-loop.js';
import { PromptBuilder } from './src/prompt-builder.js';
import { DiffEngine } from './src/diff-engine.js';
import { RiskClassifier } from './src/risk-classifier.js';
import { MCPServer } from './src/mcp/mcp-server.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTests() {
  const workspace = path.resolve(__dirname, '../'); // Parent dir
  const agentSourceDir = __dirname;
  
  const diffEngine = new DiffEngine(workspace);
  const mcpServer = new MCPServer(workspace, diffEngine);
  const promptBuilder = new PromptBuilder(workspace, agentSourceDir);
  const riskClassifier = new RiskClassifier();
  
  const agent = new AgentLoop({
    workspace,
    mcpServer,
    promptBuilder,
    diffEngine,
    riskClassifier,
    editor: 'code',
    configHome: path.join(__dirname, '.test-gemini-agent'),
    continueSession: false,
    agentSourceDir
  });

  console.log('--- TESTING COMMANDS ---');
  
  console.log('\n[TEST 1] /workspace /tmp');
  let res = await agent.handleSlashCommand('workspace', ['/tmp']);
  console.log('Output:', res.message);
  console.log('Agent workspace updated:', agent.workspace === '/tmp' ? '✅' : '❌');
  console.log('MCPServer workspace updated:', agent.mcpServer.workspace === '/tmp' ? '✅' : '❌');
  
  console.log('\n[TEST 2] /agent-dir');
  res = await agent.handleSlashCommand('agent-dir', []);
  console.log('Output:', res.message);
  console.log('Agent workspace matches agentSourceDir:', agent.workspace === agentSourceDir ? '✅' : '❌');
  console.log('Context Manager workspace updated:', agent.contextManager.workspacePath === agentSourceDir ? '✅' : '❌');

  console.log('\n[TEST 3] /compact warning check');
  // Fill history to trigger warning
  for(let i = 0; i < 2000; i++) {
    agent.conversationHistory.push({ role: 'user', content: 'filler '.repeat(100) });
  }
  let warningSent = false;
  const mockCallbacks = {
    sendToPanel: (data) => {
      if (data.payload.message.includes('⚠️ Context size high')) warningSent = true;
    },
    injectPrompt: () => {} // Prevent actual network call
  };
  
  // This might attempt to call Gemini if it reaches that far, but we just want to see the warning
  try {
    await agent.handleUserMessage('test', mockCallbacks);
  } catch (e) {
    // Ignore error if it tries to send WS message
  }
  console.log('Auto-compact warning sent:', warningSent ? '✅' : '❌');
}

runTests().catch(console.error);
