// ===== Appearance =====
// Settings arrive from an async storage read, after the first paint. The last
// applied appearance is mirrored to localStorage so a page opens in it rather
// than flashing the default theme. This file loads in <head> for that reason.
const APPEARANCE_CACHE_KEY = 'sidemind:appearance';

function applyThemeClass(theme) {
  const root = document.documentElement;
  root.classList.remove('light-theme', 'dark-theme');
  // Anything else follows the system (see the media query in ui.css)
  if (theme === 'light' || theme === 'dark') root.classList.add(`${theme}-theme`);
}

function cachedAppearance() {
  try {
    return JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY)) || {};
  } catch {
    return {};
  }
}

function cacheAppearance({ theme, fontSize, fontFamily }) {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ theme, fontSize, fontFamily }));
  } catch {}
}

try {
  applyThemeClass(cachedAppearance().theme);
} catch {}

// ===== Provider host access =====
// Extension pages need host permission to reach providers that do not send
// CORS headers. Permissions are per device: they do not sync with settings.
function providerOrigins(baseUrl) {
  try {
    return [`${new URL(baseUrl).origin}/*`];
  } catch {
    return [];
  }
}

async function hasProviderAccess(baseUrl) {
  const origins = providerOrigins(baseUrl);
  if (!origins.length || !chrome.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return true;
  }
}

// Must be called synchronously from a user gesture: nothing may be awaited
// before the request. Chrome answers true without prompting if already granted.
async function requestProviderAccess(baseUrls) {
  const origins = [...new Set(baseUrls.flatMap(providerOrigins))];
  if (!origins.length) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch (error) {
    console.error('Provider permission:', error);
    return false;
  }
}

// ===== Dialog keyboard navigation =====
// Native dialogs handle background inertness and focus restoration. Explicit
// wrapping keeps Tab within the dialog rather than visiting browser chrome.
document.addEventListener('keydown', handleDialogTab);

// Both pages write the same sync item. Check its byte limit before committing
// edits so a long role or model list gets an actionable error.
function assertConfigFitsSync(config) {
  const limit = chrome.storage.sync.QUOTA_BYTES_PER_ITEM || 8192;
  const size = new TextEncoder().encode(JSON.stringify(config)).length + 'config'.length;
  if (size > limit) {
    const error = new Error('Settings exceed the sync size limit (8 KB). Shorten roles or remove unused models, then retry.');
    error.name = 'SyncQuotaError';
    throw error;
  }
}

function handleDialogTab(event) {
  if (event.key !== 'Tab') return;
  const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return;
  const controls = Array.from(
    dialog.querySelectorAll('button, input, textarea, select, a[href], summary, [tabindex]')
  ).filter(
    (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length
  );
  if (!controls.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}

// ===== Comparing values =====
// chrome.storage hands objects back with their keys in alphabetical order and
// without undefined fields, so text from JSON.stringify of a value that went
// through storage differs from that of the original. Compare with sameValue
// whenever either side may have been stored.
function canonicalJSON(value) {
  return JSON.stringify(value, (key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  );
}

const sameValue = (a, b) => canonicalJSON(a) === canonicalJSON(b);

// ===== Shared icons =====
function createIcon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ui-icon${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `../assets/icons.svg#${name}`);
  svg.appendChild(use);
  return svg;
}
