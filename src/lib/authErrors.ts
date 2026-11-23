import { CredentialsSignin } from "next-auth";

/** Password (or SSO) was right, the account has 2FA, and no code was sent yet. */
export class TwoFactorRequired extends CredentialsSignin {
  code = "2fa_required";
}
export class InvalidTwoFactorCode extends CredentialsSignin {
  code = "invalid_code";
}
export class TooManyAttempts extends CredentialsSignin {
  code = "rate_limited";
}
