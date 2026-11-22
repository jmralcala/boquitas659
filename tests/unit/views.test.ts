import { describe, expect, it } from "vitest";
import { checkbox, csrfInput, form, passwordInput, submitButton, textInput } from "../../src/http/views/forms.js";
import { page } from "../../src/http/views/layout.js";
import { html } from "../../src/lib/html.js";

describe("forms", () => {
  it("incluye el token CSRF como campo oculto, escapado", () => {
    expect(csrfInput('a"b').toString()).toBe('<input type="hidden" name="_csrf" value="a&quot;b">');
  });

  it("las casillas de aceptación nunca vienen marcadas de antemano", () => {
    const output = checkbox({ name: "acceptPrivacy", label: "Acepto el aviso de privacidad" }).toString();
    expect(output).toContain('type="checkbox"');
    expect(output).toContain('name="acceptPrivacy"');
    expect(output).not.toMatch(/\bchecked\b/);
    expect(output).toContain("Acepto el aviso de privacidad");
  });

  it("escapa etiquetas, valores y errores", () => {
    const output = textInput({
      name: "email",
      label: "<b>Correo</b>",
      value: '"><script>x</script>',
      errors: ["<i>mal</i>"],
    }).toString();
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<b>");
    expect(output).toContain("&lt;i&gt;mal&lt;/i&gt;");
  });

  it("los campos de contraseña nunca devuelven el valor y desactivan el autocompletado de relleno", () => {
    const output = passwordInput({ name: "password", label: "Contraseña", autocomplete: "current-password" }).toString();
    expect(output).toContain('type="password"');
    expect(output).not.toMatch(/value=/);
    expect(output).toContain('autocomplete="current-password"');
  });

  it("form arma el formulario con método, acción y token", () => {
    const output = form({ action: "/login", csrf: "tok", children: [submitButton("Entrar")] }).toString();
    expect(output).toContain('<form method="post" action="/login">');
    expect(output).toContain('name="_csrf" value="tok"');
    expect(output).toContain("<button type=\"submit\">Entrar</button>");
  });

  it("form con archivos usa multipart", () => {
    const output = form({ action: "/x", csrf: "t", multipart: true, children: [] }).toString();
    expect(output).toContain('enctype="multipart/form-data"');
  });
});

describe("layout", () => {
  it("incluye título, idioma y el pie con el aviso de privacidad y derechos", () => {
    const output = page({ title: "Entrar", content: html`<p>hola</p>` });
    expect(output).toContain('<html lang="es">');
    expect(output).toContain("<title>Entrar</title>");
    expect(output).toContain('href="/legal"');
    expect(output).toContain('href="/derechos"');
    expect(output).toContain("<p>hola</p>");
  });

  it("escapa el título", () => {
    expect(page({ title: "<script>", content: html`` })).toContain("<title>&lt;script&gt;</title>");
  });
});
