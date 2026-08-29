/**
 * State management for service worker
 */
export async function getState() {
  const { agentState = {} } = await chrome.storage.session.get('agentState');
  return {
    connected: false,
    reconnectAttempts: 0,
    lastError: null,
    ...agentState,
  };
}

export async function setState(updates) {
  const current = await getState();
  await chrome.storage.session.set({
    agentState: { ...current, ...updates },
  });
}
