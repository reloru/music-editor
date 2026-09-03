import './styles.css';
import { App } from './ui/app';

const app = new App();

// `vite build --mode probe` produces a build that hands the editor to the
// touch-gesture harness in `gesture-probe.mjs`, which needs to read the
// viewport range and the selection — neither of which appears in the DOM.
// MODE is a compile-time constant, so this whole branch is dropped from the
// production bundle rather than shipped behind a runtime check.
if (import.meta.env.MODE === 'probe') {
  (window as unknown as { __app: App }).__app = app;
}

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
