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
