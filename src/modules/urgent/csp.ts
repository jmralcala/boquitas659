const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Amplía la política de seguridad de contenido con lo mínimo que necesita el widget de Turnstile (su script y su marco):
 * solo la usa la ruta de urgencia, el resto de la aplicación conserva la política estricta.
 */
export function withTurnstileCsp(current: string): string {
  if (current === "") return current;
  const directives = current.split(";").map((directive) => directive.trim()).filter((directive) => directive !== "");
  // Script y marco del widget, y las peticiones que hace a su propio origen (connect-src). El resto de la política,
  // incluidos los estilos, sigue siendo estrictamente 'self'.
  for (const name of ["script-src", "frame-src", "connect-src"]) {
    const index = directives.findIndex((directive) => directive.split(/\s+/)[0] === name);
    if (index >= 0) {
      if (!directives[index]?.includes(TURNSTILE_ORIGIN)) directives[index] = `${directives[index]} ${TURNSTILE_ORIGIN}`;
    } else {
      directives.push(name === "frame-src" ? `frame-src ${TURNSTILE_ORIGIN}` : `${name} 'self' ${TURNSTILE_ORIGIN}`);
    }
  }
  return directives.join(";");
}
