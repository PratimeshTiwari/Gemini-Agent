/**
 * GitHub Bridge — Content Script
 *
 * Injected into github.com pages. Provides real-time PR comment detection
 * as a supplement to the API poller. When the user is browsing a PR page,
 * this script detects new comments via MutationObserver and forwards them
 * to the background service worker.
 *
 * This is a SUPPLEMENTARY channel — the API poller is the source of truth.
 * This just provides faster detection when the user is already on GitHub.
 */

// ── State ────────────────────────────────────────────────────────────
let observer = null;
let lastSeenCommentIds = new Set();
let currentPR = null;
let isInitialized = false;

// ── PR Detection ─────────────────────────────────────────────────────

/**
 * Detect if we're on a PR page and extract PR metadata.
 */
function detectPRPage() {
  // URL pattern: /owner/repo/pull/123
  const match = window.location.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );

  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3]),
    full_name: `${match[1]}/${match[2]}`,
    url: window.location.href,
  };
}

// ── Comment Extraction ───────────────────────────────────────────────

/**
 * Extract all visible comment elements from the PR page DOM.
 */
function extractComments() {
  const comments = [];

  // Timeline comments (general PR comments)
  const timelineComments = document.querySelectorAll('.timeline-comment');
  for (const el of timelineComments) {
    const comment = parseCommentElement(el, 'issue_comment');
    if (comment) comments.push(comment);
  }

  // Review comments (inline code comments)
  const reviewComments = document.querySelectorAll('.review-comment');
  for (const el of reviewComments) {
    const comment = parseCommentElement(el, 'review_comment');
    if (comment) comments.push(comment);
  }

  // Also try the newer GitHub UI comment selectors
  const newUIComments = document.querySelectorAll('[data-testid="comment-body"]');
  for (const el of newUIComments) {
    const wrapper = el.closest('.js-comment-container') || el.closest('[id^="issuecomment-"]');
    if (wrapper) {
      const comment = parseCommentElement(wrapper, 'issue_comment');
      if (comment && !comments.find(c => c.id === comment.id)) {
        comments.push(comment);
      }
    }
  }

  return comments;
}

/**
 * Parse a single comment DOM element into a structured object.
 */
function parseCommentElement(el, type) {
  try {
    // Extract comment ID from the element
    const idMatch = el.id?.match(/(?:issuecomment-|r)(\d+)/);
    const id = idMatch ? idMatch[1] : el.id || null;
    if (!id) return null;

    // Author
    const authorEl =
      el.querySelector('.author') ||
      el.querySelector('a.timeline-comment-header-text') ||
      el.querySelector('[data-testid="author-link"]');
    const author = authorEl?.textContent?.trim() || 'unknown';

    // Body text
    const bodyEl =
      el.querySelector('.comment-body') ||
      el.querySelector('.review-comment-contents .comment-body') ||
      el.querySelector('[data-testid="comment-body"]') ||
      el.querySelector('.js-comment-body');
    const body = bodyEl?.textContent?.trim() || '';

    // Timestamp
    const timeEl = el.querySelector('relative-time') || el.querySelector('time');
    const created_at = timeEl?.getAttribute('datetime') || new Date().toISOString();

    // Permalink
    const linkEl = el.querySelector('a.timestamp') || el.querySelector('a[href*="#issuecomment"]');
    const html_url = linkEl?.href || window.location.href;

    // For review comments: file path and diff context
    let path = null;
    let line = null;
    let diff_hunk = null;

    if (type === 'review_comment') {
      const fileHeader = el.closest('.file')?.querySelector('.file-header');
      path = fileHeader?.getAttribute('data-path') || null;

      const lineEl = el.closest('tr');
      const lineNum = lineEl?.querySelector('.js-linkable-line-number');
      line = lineNum ? parseInt(lineNum.getAttribute('data-line-number')) : null;

      const diffTable = el.closest('.diff-table');
      if (diffTable) {
        const diffLines = diffTable.querySelectorAll('.blob-code');
        diff_hunk = Array.from(diffLines)
          .slice(0, 10)
          .map(l => l.textContent)
          .join('\n');
      }
    }

    return {
      id,
      body,
      author,
      created_at,
      html_url,
      type,
      path,
      line,
      diff_hunk,
    };
  } catch (err) {
    console.warn('[GitHub Bridge] Failed to parse comment:', err);
    return null;
  }
}

// ── MutationObserver ─────────────────────────────────────────────────

/**
 * Start observing the DOM for new comments.
 */
function startObserving() {
  if (observer) {
    observer.disconnect();
  }

  const targetNode =
    document.querySelector('.js-discussion') ||
    document.querySelector('#discussion_bucket') ||
    document.querySelector('[data-testid="pull-request-page"]') ||
    document.body;

  observer = new MutationObserver((mutations) => {
    let hasNewContent = false;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node is or contains a comment
            if (
              node.classList?.contains('timeline-comment') ||
              node.classList?.contains('review-comment') ||
              node.querySelector?.('.timeline-comment, .review-comment, [data-testid="comment-body"]')
            ) {
              hasNewContent = true;
              break;
            }
          }
        }
      }
      if (hasNewContent) break;
    }

    if (hasNewContent) {
      // Debounce: wait a tick for DOM to settle
      setTimeout(() => checkForNewComments(), 500);
    }
  });

  observer.observe(targetNode, {
    childList: true,
    subtree: true,
  });

  console.log('[GitHub Bridge] MutationObserver started');
}

/**
 * Check for comments we haven't seen yet and send them.
 */
function checkForNewComments() {
  const allComments = extractComments();
  const newComments = allComments.filter(c => !lastSeenCommentIds.has(c.id));

  if (newComments.length > 0) {
    console.log(`[GitHub Bridge] Detected ${newComments.length} new comment(s)`);

    for (const comment of newComments) {
      lastSeenCommentIds.add(comment.id);

      // Send to background service worker
      try {
        chrome.runtime.sendMessage({
          type: 'github_pr_comment',
          payload: {
            pr: currentPR,
            comment,
          },
        });
      } catch (err) {
        console.warn('[GitHub Bridge] Failed to send comment to background:', err);
      }
    }
  }
}

// ── Initialization ───────────────────────────────────────────────────

function initialize() {
  if (isInitialized) return;

  currentPR = detectPRPage();
  if (!currentPR) {
    // Not on a PR page, nothing to do
    return;
  }

  isInitialized = true;
  console.log(`[GitHub Bridge] Detected PR #${currentPR.number} on ${currentPR.full_name}`);

  // Seed with existing comments (so we don't re-send old ones)
  const existingComments = extractComments();
  for (const c of existingComments) {
    lastSeenCommentIds.add(c.id);
  }
  console.log(`[GitHub Bridge] Seeded ${existingComments.length} existing comments`);

  // Notify the background about the PR we're viewing
  try {
    chrome.runtime.sendMessage({
      type: 'github_pr_viewing',
      payload: { pr: currentPR },
    });
  } catch (err) {
    console.warn('[GitHub Bridge] Failed to notify background:', err);
  }

  // Start watching for new comments
  startObserving();
}

// ── URL Change Detection (SPA navigation) ────────────────────────────

let lastUrl = window.location.href;

function checkUrlChange() {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    isInitialized = false;
    lastSeenCommentIds.clear();
    currentPR = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // Re-initialize for new page
    setTimeout(initialize, 1000); // Wait for DOM to render
  }
}

// Check for SPA navigation periodically
setInterval(checkUrlChange, 2000);

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

console.log('[GitHub Bridge] Content script loaded');
