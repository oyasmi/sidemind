// Register listeners synchronously so MV3 can wake this worker for gestures.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId })
    .catch((error) => console.error('Opening SideMind:', error));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ask-sidemind',
    title: 'Ask SideMind about selected text',
    contexts: ['selection']
  }, () => {
    if (chrome.runtime.lastError) console.error('Creating selection menu:', chrome.runtime.lastError.message);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ask-sidemind' || !info.selectionText || !tab) return;
  // Start opening before awaiting storage: Chrome requires the original user
  // gesture. Session storage also covers panels that haven't loaded yet.
  try {
    const opening = chrome.sidePanel.open({ windowId: tab.windowId });
    const text = info.selectionText;
    const url = info.frameUrl || info.pageUrl || '';
    await Promise.all([
      opening,
      chrome.storage.session.set({
        [`selection:${tab.windowId}`]: {
          text: text.slice(0, 20000),
          truncated: text.length > 20000,
          title: (tab.title || '').replace(/\s+/g, ' '),
          url: /^https?:\/\//i.test(url) ? url : ''
        }
      })
    ]);
  } catch (error) {
    console.error('Opening selected text in SideMind:', error);
  }
});
