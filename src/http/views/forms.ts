import { html, type SafeHtml } from "../../lib/html.js";
import { CSRF_FIELD } from "../csrf.js";

export function csrfInput(token: string): SafeHtml {
  return html`<input type="hidden" name="${CSRF_FIELD}" value="${token}">`;
}

function errorList(errors: readonly string[] | undefined): SafeHtml | null {
  if (!errors || errors.length === 0) return null;
  return html`<ul class="errors" role="alert">${errors.map((message) => html`<li>${message}</li>`)}</ul>`;
}

interface FieldOptions {
  name: string;
  label: string;
  required?: boolean;
  autocomplete?: string;
  errors?: readonly string[];
}

export function textInput(options: FieldOptions & { type?: "text" | "email" | "tel" | "date"; value?: string }): SafeHtml {
  return html`<p>
  <label>${options.label}
    <input type="${options.type ?? "text"}" name="${options.name}" value="${options.value ?? ""}"${options.required ? html` required` : null}${options.autocomplete ? html` autocomplete="${options.autocomplete}"` : null}>
  </label>
  ${errorList(options.errors)}
</p>`;
}

/** Nunca devuelve el valor ingresado: una contraseña no se vuelve a pintar en la página. */
export function passwordInput(options: FieldOptions): SafeHtml {
  return html`<p>
  <label>${options.label}
    <input type="password" name="${options.name}"${options.required ? html` required` : null}${options.autocomplete ? html` autocomplete="${options.autocomplete}"` : null}>
  </label>
  ${errorList(options.errors)}
</p>`;
}

/** Casilla de aceptación. No admite valor inicial: siempre aparece sin marcar. */
export function checkbox(options: { name: string; label: string | SafeHtml; errors?: readonly string[] }): SafeHtml {
  return html`<p>
  <label><input type="checkbox" name="${options.name}" value="yes"> ${options.label}</label>
  ${errorList(options.errors)}
</p>`;
}

export function fileInput(options: { name: string; label: string; accept?: string; errors?: readonly string[] }): SafeHtml {
  return html`<p>
  <label>${options.label}
    <input type="file" name="${options.name}"${options.accept ? html` accept="${options.accept}"` : null}>
  </label>
  ${errorList(options.errors)}
</p>`;
}

/** Botón de envío: primario por defecto; `danger` para acciones destructivas (cancelar, revocar) y `secondary` para las accesorias. */
export function submitButton(label: string, variant?: "danger" | "secondary"): SafeHtml {
  return variant ? html`<button type="submit" class="btn-${variant}">${label}</button>` : html`<button type="submit">${label}</button>`;
}

export function form(options: {
  action: string;
  csrf: string;
  children: readonly (SafeHtml | null)[];
  multipart?: boolean;
}): SafeHtml {
  return html`<form method="post" action="${options.action}"${options.multipart ? html` enctype="multipart/form-data"` : null}>
${csrfInput(options.csrf)}
${options.children}
</form>`;
}

export { errorList };
