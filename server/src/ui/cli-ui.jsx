import React from 'react';
import { render } from 'ink';
import { MouseProvider } from '@ink-tools/ink-mouse';
import { App } from './App.jsx';

export class CliUI {
  constructor(agentLoop, wsServer) {
    this.agentLoop = agentLoop;
    this.wsServer = wsServer;
  }

  start() {
    console.clear();
    // Render the Ink App component, passing the necessary instances
    // MouseProvider enables terminal mouse tracking so expandable rows and the
    // input box respond to clicks. Text selection needs Option/Shift held while
    // tracking is on — that is a terminal-level constraint, not a bug.
    const { waitUntilExit } = render(
      <MouseProvider>
        <App agentLoop={this.agentLoop} wsServer={this.wsServer} />
      </MouseProvider>
    );
    
    // Optional: await waitUntilExit() if we wanted to block, 
    // but the original architecture just launched the UI and let events drive it.
  }
}
