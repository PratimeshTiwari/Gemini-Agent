import('./src/prompt-builder.js').then(m => {
  const pb = new m.PromptBuilder(process.cwd());
  console.log(pb.buildPrompt({ userMessage: "test", mode: "plan" }));
}).catch(console.error);
