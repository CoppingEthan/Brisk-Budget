// Installing Brisk Budget as an app, and its service worker (public/sw.js), which keeps the app's
// own files so it opens quickly and still opens when the server can't be reached. Browsers only
// allow both on a secure address: https://, or this computer (localhost).
import { storage, store } from './dom.js';

// The fingerprint on this page's own files; the server sends its current one with every response
export const pageBuild = new URL(import.meta.url).searchParams.get('v');

const listeners = new Set();
let installPrompt = null;
let registration = null;

const notify = () => listeners.forEach(fn => fn());
export const onInstallChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Chrome and Edge (Android and desktop) say when the app can be installed. Keep the offer for an
// Install button rather than letting the browser pop its own bar over the app's tab bar.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  notify();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  notify();
});

export const canInstall = () => !!installPrompt;

// Ask the browser to install the app. Resolves to true when the person said yes.
export async function install() {
  const prompt = installPrompt;
  if (!prompt) return false;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  notify();
  return outcome === 'accepted';
}

// Running as an installed app (from the home screen or an app window) rather than a browser tab
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// iPhone and iPad (which calls itself a Mac but has a touch screen). Every browser there adds to
// the home screen through the Share menu; none offers an install prompt.
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export const swSupported = () => 'serviceWorker' in navigator && window.isSecureContext;

// Register the service worker once the page has loaded, so it doesn't compete with the app for
// the connection. onUpdate() is called when a newer version of the app has taken over (another
// tab, or the update check below, found it).
export function startServiceWorker({ onUpdate }) {
  if (!swSupported()) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'activated' && pageBuild && event.data.build !== pageBuild) onUpdate();
  });
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => { registration = reg; })
      .catch(err => console.warn("Brisk Budget couldn't set up offline opening:", err.message));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// The server is running a different version: fetch the new service worker now rather than
// whenever the browser next checks, so the saved copy of the app is the new one too
export function checkForAppUpdate() {
  registration?.update().catch(() => {});
}

// Offer to install, once per browser and not before the app is opened a second time, so it isn't
// the first thing anyone sees. offer(kind) shows the offer: 'prompt' when the browser can
// install it, 'ios' for the Share › Add to Home Screen hint.
const VISITS_KEY = 'briskBudget_visits';
const OFFERED_KEY = 'briskBudget_installOffered';
export function offerInstallOnce(offer) {
  if (isStandalone() || storage(OFFERED_KEY, false)) return;
  const visits = storage(VISITS_KEY, 0) + 1;
  store(VISITS_KEY, visits);
  if (visits < 2) return;
  const show = (kind) => {
    if (storage(OFFERED_KEY, false)) return;
    store(OFFERED_KEY, true);
    offer(kind);
  };
  if (isIOS()) {
    setTimeout(() => show('ios'), 4000);
    return;
  }
  const whenReady = () => {
    if (!canInstall()) return;
    unsubscribe();
    setTimeout(() => { if (canInstall()) show('prompt'); }, 4000);
  };
  const unsubscribe = onInstallChange(whenReady);
  whenReady();
}
