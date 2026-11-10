/**
 * The gallery of the UI layer: every screen of the mockups, drawn by the real
 * components of `client/src/ui/` with example data, one per hash
 * (`ui.html#w01`). It is the harness, not the layer: the gallery may read the
 * URL and own state, the components it renders may not.
 *
 * `?theme=dark` renders the dark theme, `?lang=en` the English catalogue.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './use-sarim-world';
import '../index.css';
import { UI_COPY_IT } from '../ui/copy/i18n-ui-it';
import { UI_COPY_EN } from '../ui/copy/i18n-ui-en';
import { Gallery } from './Gallery';

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
const copy = params.get('lang') === 'en' ? UI_COPY_EN : UI_COPY_IT;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery copy={copy} />
  </StrictMode>,
);
