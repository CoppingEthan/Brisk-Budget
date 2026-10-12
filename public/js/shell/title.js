// Page title in the browser tab and the phone top bar
export function setTitle(text) {
  const el = document.querySelector('[data-topbar-title]');
  if (el) el.textContent = text || 'Brisk Budget';
  document.title = text && text !== 'Dashboard' ? `${text} · Brisk Budget` : 'Brisk Budget';
}
