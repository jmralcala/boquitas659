import { describe, expect, it } from "vitest";
import { html } from "../../src/lib/html.js";
import { calendarLayout, formatDate, formatDateTime, formatTime } from "../../src/http/views/calendar.js";

const MX = "America/Mexico_City";
const TJ = "America/Tijuana";
const INSTANT = new Date("2026-06-15T17:30:00.000Z");

describe("formato de fechas y horas en la zona del consultorio", () => {
  it("muestra la hora local, no la de UTC", () => {
    expect(formatTime(MX, INSTANT)).toBe("11:30");
    expect(formatTime(TJ, INSTANT)).toBe("10:30"); // verano: UTC−7
    expect(formatTime(TJ, new Date("2026-01-15T17:30:00.000Z"))).toBe("09:30"); // invierno: UTC−8
  });

  it("la fecha cambia de día según la zona", () => {
    const lateUtc = new Date("2026-06-16T03:30:00.000Z"); // todavía 15 de junio en México
    expect(formatDate(MX, lateUtc)).toContain("15");
    expect(formatDate(MX, lateUtc)).toContain("junio");
    expect(formatDate(MX, lateUtc).toLowerCase()).toContain("lunes");
  });

  it("combina fecha y hora", () => {
    const text = formatDateTime(MX, INSTANT);
    expect(text).toContain("11:30");
    expect(text).toContain("junio");
  });
});

describe("calendarLayout", () => {
  it("escapa el título y deja pasar el contenido ya seguro", () => {
    const out = calendarLayout({ title: "<script>alert(1)</script>", content: html`<p>${"<b>x</b>"}</p>`, canConfigure: true });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("ya no arma su propia navegación: la barra lateral común (shell) la añade según el rol", () => {
    // Que el médico vea «Configuración» y recepción no lo comprueba tests/contract/design-shell.test.ts.
    for (const canConfigure of [true, false]) {
      const out = calendarLayout({ title: "t", content: html`<p>x</p>`, canConfigure });
      expect(out).not.toContain("<nav");
      expect(out).not.toContain("/agenda/configuracion");
      expect(out).toContain('<main id="contenido">');
    }
  });
});
