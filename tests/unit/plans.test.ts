import { describe, expect, it } from "vitest";
import { DISCOUNT_PERCENT, formatMxn, PLANS, priceWithDiscount } from "../../src/http/views/plans.js";

describe("precios de los planes (FR-011, FR-016)", () => {
  it("el descuento es de 30 % y los tres planes salen en orden", () => {
    expect(DISCOUNT_PERCENT).toBe(30);
    expect(PLANS.map((plan) => plan.name)).toEqual(["Esencial", "Profesional", "Élite"]);
    expect(PLANS.map((plan) => plan.priceMxn)).toEqual([499, 999, 1999]);
    expect(PLANS.map((plan) => plan.trialDays)).toEqual([5, null, null]);
  });

  it("el precio con descuento es el 70 % redondeado al peso: 349, 699 y 1399", () => {
    expect(PLANS.map((plan) => priceWithDiscount(plan.priceMxn))).toEqual([349, 699, 1399]);
  });

  it("para cualquier precio entero difiere del 70 % exacto en medio peso o menos y es menor que el original", () => {
    for (let price = 1; price <= 5000; price += 1) {
      const discounted = priceWithDiscount(price);
      expect(Math.abs(discounted - price * 0.7), `precio ${price}`).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(discounted, `precio ${price}`).toBeLessThanOrEqual(price);
    }
  });

  it("formatea pesos enteros con separador de miles y sin centavos", () => {
    expect(formatMxn(0)).toBe("$0");
    expect(formatMxn(499)).toBe("$499");
    expect(formatMxn(1399)).toBe("$1,399");
    expect(formatMxn(1999)).toBe("$1,999");
    expect(formatMxn(1234567)).toBe("$1,234,567");
  });
});
