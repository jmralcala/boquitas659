/** Fragmento de HTML ya seguro: no se vuelve a escapar al interpolarse. */
export class SafeHtml {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => escapes[char] ?? char);
}

/** Marca una cadena como HTML seguro. Usar solo con contenido propio, nunca con entrada del usuario. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

type Interpolable = string | number | boolean | null | undefined | SafeHtml | readonly Interpolable[];

function render(value: Interpolable): string {
  if (value === null || value === undefined || value === false || value === true) return "";
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

/** Etiqueta de plantilla que escapa por defecto cada valor interpolado. */
export function html(strings: TemplateStringsArray, ...values: Interpolable[]): SafeHtml {
  let out = "";
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index < values.length) out += render(values[index] as Interpolable);
  });
  return new SafeHtml(out);
}
