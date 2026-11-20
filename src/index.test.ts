import { describe, expect, it } from "vitest";
import { saludar } from "./index.js";

describe("saludar", () => {
  it("devuelve el saludo", () => {
    expect(saludar("mundo")).toBe("Hola, mundo");
  });
});
