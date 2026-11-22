const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_AGE_YEARS = 120;

function parts(isoDate: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Se comprueba que la fecha exista de verdad (nada de 30 de febrero).
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria indicada, por ejemplo la del consultorio. */
export function todayInZone(now: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return formatted; // en-CA da AAAA-MM-DD
}

/**
 * Valida una fecha de nacimiento AAAA-MM-DD: debe existir, no ser futura y no pasar de 120 años.
 * Devuelve la misma cadena si es válida o `null`. Se guarda la fecha, nunca la edad.
 */
export function parseBirthDate(raw: string, today: string): string | null {
  const birth = parts(raw);
  const now = parts(today);
  if (!birth || !now) return null;
  if (raw > today) return null;
  if (now.year - birth.year > MAX_AGE_YEARS) return null;
  return raw;
}

/** Años cumplidos a la fecha `today`. Quien nació un 29 de febrero cumple el 1 de marzo en años no bisiestos. */
export function calculateAge(birthDate: string, today: string): number {
  const birth = parts(birthDate);
  const now = parts(today);
  if (!birth || !now) throw new Error("Fecha inválida.");
  if (birthDate > today) throw new Error("La fecha de nacimiento es futura.");

  let age = now.year - birth.year;
  let birthdayMonth = birth.month;
  let birthdayDay = birth.day;
  const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (birthdayMonth === 2 && birthdayDay === 29 && !isLeapYear(now.year)) {
    birthdayMonth = 3;
    birthdayDay = 1;
  }
  if (now.month < birthdayMonth || (now.month === birthdayMonth && now.day < birthdayDay)) age -= 1;
  return age;
}
