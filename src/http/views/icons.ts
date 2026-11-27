import { raw, type SafeHtml } from "../../lib/html.js";

/**
 * Íconos de trazo en línea (estilo Lucide, licencia ISC), dibujados a mano: sin librería ni fuente de íconos, para no
 * pedir nada a terceros (FR-016). Todos usan `currentColor` y son decorativos (`aria-hidden`).
 */
const PATHS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14c2.2.6 3.5 2.6 3.5 6"/>',
  appointments: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6M9 15h6"/>',
  building: '<path d="M4 21V5l8-2 8 2v16"/><path d="M9 21v-5h6v5M9 9h.01M15 9h.01M9 13h.01M15 13h.01"/>',
  doctors: '<path d="M6 3v6a4 4 0 008 0V3"/><path d="M10 13v2a5 5 0 0010 0v-2"/><circle cx="20" cy="11" r="2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>',
  history: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.4M3 4v4h4M12 7v5l3 2"/>',
  logout: '<path d="M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4M16 8l4 4-4 4M20 12H9"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  warning: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  // Portada (feature 7)
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 004 0"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  "log-in": '<path d="M15 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M10 8l4 4-4 4M14 12H3"/>',
  // Páginas informativas (feature 8)
  check: '<path d="M5 12l4 4 10-10"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Ícono de trazo de 18 px. Sin texto: va siempre junto a una etiqueta visible o dentro de un control con nombre accesible. */
export function icon(name: IconName): SafeHtml {
  return raw(`<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`);
}

/** Logo del producto: un diente en trazo blanco (se pinta sobre un cuadro de color primario). */
export function logo(): SafeHtml {
  return raw(
    '<svg class="logo" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 3c-2.2 0-4 1.8-4 4 0 2 .8 3.4 1.5 5 .8 1.8.7 4 1.2 6.2.3 1.3 1.2 2.3 2.3 2.3 1.4 0 1.5-2.2 2-3.8.3-.9.8-1.5 1.5-1.5s1.2.6 1.5 1.5c.5 1.6.6 3.8 2 3.8 1.1 0 2-1 2.3-2.3.5-2.2.4-4.4 1.2-6.2C20.2 10.4 21 9 21 7c0-2.2-1.8-4-4-4-1.6 0-2.4.6-3.4 1.2-.5.3-1.1.5-1.6.5s-1.1-.2-1.6-.5C9.4 3.6 8.6 3 7 3z"/></svg>',
  );
}
