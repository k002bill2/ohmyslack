import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { App } from '../src/App.js';

describe('App', () => {
  it('renders an empty main shell', () => {
    expect(renderToString(<App />)).toBe('<main></main>');
  });
});
