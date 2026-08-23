import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.jsx';

export class CliUI {
  constructor(agentLoop, wsServer) {
    this.agentLoop = agentLoop;
    this.wsServer = wsServer;
  }

  start() {
    console.clear();
    // Render the Ink App component, passing the necessary instances
    const { waitUntilExit } = render(
      <App agentLoop={this.agentLoop} wsServer={this.wsServer} />
    );
    
    // Optional: await waitUntilExit() if we wanted to block, 
    // but the original architecture just launched the UI and let events drive it.
  }
}
