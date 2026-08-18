import './styles.css';
import { App } from './ui/app';

new App();

// The service worker only caches the app shell so a home-screen launch works
// with no signal. It is registered after load so it never competes with the
// first paint.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is optional; the editor works without it.
    });
  });
}
