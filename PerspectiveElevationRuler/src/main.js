// Entry point. Everything else is a module so the projection maths can be
// tested under Node without a browser anywhere in sight.

import { App } from './ui/App.js';

const start = () => {
  window.app = new App(document);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
