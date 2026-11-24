import { describe, expect, it } from "vitest";
import { formatDateTime, formatPhone, formatTime, phoneNotice, sitePage } from "../../src/http/views/site.js";
import { html } from "../../src/lib/html.js";

describe("sitePage", () => {
  it("escapa el título y el contenido interpolado, y lleva noindex y el pie con el aviso de privacidad", () => {
    const out = sitePage({ title: "<script>alert(1)</script>", content: html`<p>${"<b>x</b>"}</p>` });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).toContain('name="robots" content="noindex"');
    expect(out).toContain('href="/legal"');
    expect(out).toContain('href="/derechos"');
  });
});

describe("formatPhone y phoneNotice", () => {
  it("da formato a un teléfono de 10 dígitos y rechaza cualquier otra cosa", () => {
    expect(formatPhone("5598765432")).toBe("55 9876 5432");
    for (const bad of [null, "", "123", "55987654321", "55-9876-5432", "ABCDE12345", "5598765432 "]) expect(formatPhone(bad)).toBe("");
  });

  it("phoneNotice enlaza el teléfono y no muestra nada sin un número válido", () => {
    const notice = phoneNotice("5598765432")?.toString() ?? "";
    expect(notice).toContain('href="tel:5598765432"');
    expect(notice).toContain("55 9876 5432");
    expect(phoneNotice(null)).toBeNull();
    expect(phoneNotice("<script>")).toBeNull();
  });
});

describe("formato de fechas en la zona del consultorio", () => {
  it("muestra la hora local y no la de UTC", () => {
    const instant = new Date("2026-06-15T17:30:00.000Z");
    expect(formatTime("America/Mexico_City", instant)).toBe("11:30");
    expect(formatTime("America/Tijuana", instant)).toBe("10:30");
    expect(formatDateTime("America/Mexico_City", instant)).toContain("junio");
  });
});
