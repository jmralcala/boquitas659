import { describe, expect, it } from "vitest";
import { parsePublishArgs } from "../../src/modules/legal/publish-args.js";

describe("parsePublishArgs", () => {
  it("por omisión el documento se publica como provisional", () => {
    expect(parsePublishArgs(["--type", "patient_privacy", "--file", "aviso.txt"])).toEqual({
      type: "patient_privacy",
      file: "aviso.txt",
      title: undefined,
      isProvisional: true,
    });
  });

  it("solo se marca como revisado con --reviewed explícito", () => {
    const args = parsePublishArgs(["--type", "terms_doctor", "--file", "t.txt", "--title", "Términos 2026", "--reviewed"]);
    expect(args).toMatchObject({ type: "terms_doctor", title: "Términos 2026", isProvisional: false });
  });

  it("rechaza un tipo que no está en la lista cerrada", () => {
    expect(() => parsePublishArgs(["--type", "otro", "--file", "a.txt"])).toThrow(/tipo/i);
  });

  it("exige tipo y archivo", () => {
    expect(() => parsePublishArgs(["--file", "a.txt"])).toThrow(/--type/);
    expect(() => parsePublishArgs(["--type", "patient_privacy"])).toThrow(/--file/);
    expect(() => parsePublishArgs([])).toThrow();
  });

  it("rechaza opciones desconocidas (no se ignoran en silencio)", () => {
    expect(() => parsePublishArgs(["--type", "patient_privacy", "--file", "a.txt", "--revisado"])).toThrow();
  });
});
