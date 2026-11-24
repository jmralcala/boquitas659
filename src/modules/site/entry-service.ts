import type { AuthenticateResult, LoginService } from "../auth/login-service.js";
import type { SessionService } from "../auth/sessions.js";
import type { PatientRegistration } from "../patients/registration-service.js";

export interface EntryServiceDeps {
  login: LoginService;
  patients: PatientRegistration;
  sessions: SessionService;
}

export interface SignInInput {
  email: string;
  password: string;
  ip: string;
  deviceCookie: string | undefined;
  currentSessionToken: string | null;
}

export interface EntryService {
  /** «Ya soy paciente»: solo cuentas de paciente; un correo de otro rol se trata como inexistente. */
  signIn(input: SignInInput): Promise<AuthenticateResult>;
  /** «Primera cita»: crea cuenta y paciente (con el aviso de privacidad vigente) y abre la sesión. */
  registerFirstAppointment(raw: unknown, currentSessionToken: string | null): Promise<{ sessionToken: string; userId: number }>;
}

export function createEntryService(deps: EntryServiceDeps): EntryService {
  return {
    signIn: (input) => deps.login.authenticate({ ...input, audience: "patient" }),

    async registerFirstAppointment(raw, currentSessionToken) {
      const { userId } = await deps.patients.register(raw);
      if (currentSessionToken) await deps.sessions.revoke(currentSessionToken);
      const { token } = await deps.sessions.create(userId);
      return { sessionToken: token, userId };
    },
  };
}
