import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appointmentBadge,
  doctorAccountBadge,
  doctorApprovalBadge,
  mailBadge,
  metricBadge,
  siteBadge,
} from "../../src/http/views/ui.js";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const styles = readFileSync(join(ROOT, "src", "http", "assets", "styles.css"), "utf8");

function rootTokens(): Map<string, string> {
  const block = /:root\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens.set(match[1] as string, (match[2] as string).trim());
  return tokens;
}

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Parejas texto sobre fondo que el sistema usa (FR-014): todas deben alcanzar 4.5:1. */
const PAIRS: ReadonlyArray<readonly [text: string, background: string]> = [
  ["--color-text", "--color-bg"],
  ["--color-text", "--color-surface"],
  ["--color-text-2", "--color-surface"],
  ["--color-text-muted", "--color-bg"],
  ["--color-text-muted", "--color-surface"],
  ["--color-text-muted", "--color-surface-2"],
  ["--color-nav", "--color-surface"],
  ["--color-on-primary", "--color-primary"],
  ["--color-on-primary", "--color-primary-hover"],
  ["--color-primary", "--color-surface"],
  ["--color-primary", "--color-bg"],
  ["--color-primary-strong", "--color-mint"],
  ["--color-primary-strong", "--color-surface"],
  ["--color-sky-text", "--color-sky"],
  ["--color-amber-text", "--color-amber"],
  ["--color-red-text", "--color-red"],
  ["--color-red-text", "--color-surface"],
  ["--color-neutral-text", "--color-neutral"],
  ["--triage-1-text", "--triage-1-bg"],
  ["--triage-2-text", "--triage-2-bg"],
  ["--triage-3-text", "--triage-3-bg"],
  ["--triage-4-text", "--triage-4-bg"],
  ["--triage-5-text", "--triage-5-bg"],
];

describe("tokens de color (FR-002, FR-014)", () => {
  const tokens = rootTokens();

  it("define los tokens de marca, estado, texto, superficie, forma y espaciado del modelo de diseño", () => {
    for (const name of [
      "--color-primary", "--color-primary-hover", "--color-primary-strong", "--color-mint", "--color-mint-2",
      "--color-sky", "--color-sky-text", "--color-amber", "--color-amber-text", "--color-red", "--color-red-text",
      "--color-text", "--color-text-2", "--color-text-muted", "--color-nav",
      "--color-bg", "--color-surface", "--color-surface-2", "--color-border", "--color-border-input", "--color-divider",
      "--font-body", "--font-heading", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-pill",
      "--space-1", "--space-4", "--space-8", "--control-h", "--shadow-sm", "--focus-ring",
      "--triage-1", "--triage-2", "--triage-3", "--triage-4", "--triage-5",
    ]) {
      expect(tokens.has(name), name).toBe(true);
    }
    expect(tokens.get("--color-primary")?.toLowerCase()).toBe("#0b7a72");
    expect(tokens.get("--control-h")).toBe("44px");
  });

  it.each(PAIRS)("%s sobre %s tiene un contraste de al menos 4.5:1", (text, background) => {
    const foreground = tokens.get(text);
    const bg = tokens.get(background);
    expect(foreground, text).toMatch(/^#[0-9a-f]{6}$/i);
    expect(bg, background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(foreground as string, bg as string)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("mapeo de estados a insignias (FR-009)", () => {
  it("cita: agendada confirmada, cancelada cancelada", () => {
    expect(appointmentBadge("booked")).toEqual({ variant: "confirmed", text: "Agendada" });
    expect(appointmentBadge("cancelled")).toEqual({ variant: "cancelled", text: "Cancelada" });
  });

  it("médico: aprobación y cuenta", () => {
    expect(doctorApprovalBadge("approved")).toEqual({ variant: "confirmed", text: "Aprobado" });
    expect(doctorApprovalBadge("pending")).toEqual({ variant: "pending", text: "Pendiente" });
    expect(doctorApprovalBadge("rejected")).toEqual({ variant: "cancelled", text: "Rechazado" });
    expect(doctorAccountBadge("active")).toEqual({ variant: "confirmed", text: "Activa" });
    expect(doctorAccountBadge("read_only")).toEqual({ variant: "in-progress", text: "Solo lectura" });
    expect(doctorAccountBadge("suspended")).toEqual({ variant: "cancelled", text: "Suspendida" });
  });

  it("micrositio, correo y métrica", () => {
    expect(siteBadge("published")).toEqual({ variant: "confirmed", text: "Publicado" });
    expect(siteBadge("draft")).toEqual({ variant: "pending", text: "Borrador" });
    expect(siteBadge("unpublished")).toEqual({ variant: "neutral", text: "Despublicado" });
    expect(mailBadge("sent")).toEqual({ variant: "confirmed", text: "Enviado" });
    expect(mailBadge("pending")).toEqual({ variant: "pending", text: "Pendiente" });
    expect(mailBadge("failed")).toEqual({ variant: "cancelled", text: "Fallido" });
    expect(mailBadge("cancelled")).toEqual({ variant: "neutral", text: "Cancelado" });
    expect(metricBadge(true)).toEqual({ variant: "confirmed", text: "Cumple" });
    expect(metricBadge(false)).toEqual({ variant: "cancelled", text: "No cumple" });
    expect(metricBadge(null)).toEqual({ variant: "neutral", text: "Sin datos" });
  });
});
