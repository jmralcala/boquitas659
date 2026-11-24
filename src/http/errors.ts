/** Error esperado de la aplicación: su mensaje es seguro de mostrar al usuario. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly fields?: Readonly<Record<string, readonly string[]>>,
  ) {
    super(publicMessage);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(fields: Record<string, string[]>) {
    super(400, "validation_error", "Revisa los datos enviados.", fields);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super(401, "unauthorized", "Inicia sesión para continuar.");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "No tienes permiso para hacer esto.") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor() {
    super(404, "not_found", "No encontramos lo que buscas.");
    this.name = "NotFoundError";
  }
}

/** Demasiados intentos: el cliente debe esperar `retryAfterMs` antes de volver a intentar. */
export class TooManyAttemptsError extends AppError {
  constructor(readonly retryAfterMs: number) {
    super(
      429,
      "rate_limited",
      `Demasiados intentos. Espera ${Math.max(1, Math.ceil(retryAfterMs / 1000))} segundos e inténtalo de nuevo.`,
    );
    this.name = "TooManyAttemptsError";
  }
}

/** La contraseña actual escrita para confirmar un cambio sensible no es correcta. */
export class WrongPasswordError extends AppError {
  constructor() {
    super(403, "wrong_password", "La contraseña actual no es correcta.", {
      currentPassword: ["La contraseña actual no es correcta."],
    });
    this.name = "WrongPasswordError";
  }
}

/** Enlace de un solo uso vencido, ya usado o revocado. */
export class InvalidLinkError extends AppError {
  constructor() {
    super(410, "invalid_link", "El enlace venció o ya se usó.");
    this.name = "InvalidLinkError";
  }
}

/** Los textos legales del rol siguen siendo provisionales (sin revisión legal): no se admiten altas en producción. */
export class LegalReviewPendingError extends AppError {
  constructor() {
    super(
      403,
      "legal_review_pending",
      "El registro todavía no está disponible: estamos terminando la revisión legal de nuestros avisos. Inténtalo de nuevo más adelante.",
    );
    this.name = "LegalReviewPendingError";
  }
}

/** La petición es válida pero choca con el estado actual (por ejemplo, un espacio que ya no está libre). */
export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(409, code, message);
    this.name = "ConflictError";
  }
}

/** El micrositio no está aceptando reservas (despublicado, o el médico ya no está aprobado). */
export class SiteUnavailableError extends AppError {
  constructor() {
    super(403, "site_unavailable", "Este consultorio no está recibiendo reservas en línea. Confirma directamente con el consultorio por teléfono.");
    this.name = "SiteUnavailableError";
  }
}
