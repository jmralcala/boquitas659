/**
 * Páginas informativas públicas (feature 8): se ven con o sin sesión y no redirigen. Por eso los filtros globales de
 * avisos legales pendientes y de segundo factor de soporte no deben intervenir en ellas. `/` no está aquí a propósito:
 * con sesión completa redirige al área del rol.
 */
export const PUBLIC_INFO_PATHS: readonly string[] = ["/como-funciona", "/planes", "/nosotros"];
