/**
 * The connected preview (`app.html`): the screens of the UI layer joined into
 * one app with tabs, sidebar and history, like Topics. The address after `#`
 * names the screen (`app.html#/pratiche/2418`); `?theme=dark` and `?lang=en`
 * work as in the gallery and stay while navigating, because only the hash
 * changes.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './use-sarim-world';
import '../index.css';
import './app/app.css';
import { UI_COPY_IT } from '../ui/copy/i18n-ui-it';
import { UI_COPY_EN } from '../ui/copy/i18n-ui-en';
import { App } from './app/App';
import { NOCERA_EDITION } from './app/edition';

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
const copy = params.get('lang') === 'en' ? UI_COPY_EN : UI_COPY_IT;
/* The language chosen in Settings > General wins over the default, not over `?lang=`. */
const copies = params.has('lang') ? undefined : { it: UI_COPY_IT, en: UI_COPY_EN };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App copy={copy} copies={copies} edition={NOCERA_EDITION} />
  </StrictMode>,
);
