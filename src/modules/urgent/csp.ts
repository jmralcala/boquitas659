const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Amplía la política de seguridad de contenido con lo mínimo que necesita el widget de Turnstile (su script y su marco):
 * solo la usa la ruta de urgencia, el resto de la aplicación conserva la política estricta.
 */
export function withTurnstileCsp(current: string): string {
  if (current === "") return current;
  const directives = current.split(";").map((directive) => directive.trim()).filter((directive) => directive !== "");
  for (const name of ["script-src", "frame-src"]) {
    const index = directives.findIndex((directive) => directive.split(/\s+/)[0] === name);
    if (index >= 0) {
      if (!directives[index]?.includes(TURNSTILE_ORIGIN)) directives[index] = `${directives[index]} ${TURNSTILE_ORIGIN}`;
    } else {
      directives.push(name === "script-src" ? `script-src 'self' ${TURNSTILE_ORIGIN}` : `frame-src ${TURNSTILE_ORIGIN}`);
    }
  }
  return directives.join(";");
}
