/** Reloj inyectable para que las caducidades sean probables sin esperar. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FixedClock extends Clock {
  set(date: Date): void;
  advance(milliseconds: number): void;
}

/** Reloj controlable para pruebas. */
export function createFixedClock(initial: Date = new Date("2026-01-01T00:00:00.000Z")): FixedClock {
  let current = initial;
  return {
    now: () => new Date(current.getTime()),
    set: (date) => {
      current = date;
    },
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}
