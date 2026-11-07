import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveApp, browserSource } from './LiveApp.js';
import { registerServiceWorker } from './features/pwa';
import 'virtual:tokens.css';
import './ui/base.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('root element missing');
}
createRoot(container).render(
  <StrictMode>
    <LiveApp fetch={(input, init) => window.fetch(input, init)} createSource={browserSource} />
  </StrictMode>,
);

registerServiceWorker({ prod: import.meta.env.PROD, navigator });
