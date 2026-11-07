import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './features/pwa';
import 'virtual:tokens.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('root element missing');
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker({ prod: import.meta.env.PROD, navigator });
