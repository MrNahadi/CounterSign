// PayPal rail: the sandbox-only REST client. It owns PayPal's JSON shapes and returns
// zod-checked records in minor units (ADR 0024).
export {
  createPayPalClient,
  type FetchLike,
  type PayPalClient,
  type PayPalClientOptions,
} from "./client";
export {
  PAYPAL_ENV_NAMES,
  type PayPalConfig,
  PayPalConfigError,
  type PayPalEnvParse,
  parsePayPalEnv,
  SANDBOX_BASE_URL,
} from "./config";
export { PayPalError, type PayPalErrorDetail, type PayPalErrorKind } from "./errors";
export type { PayPalCapture, PayPalOrder, PayPalPurchaseUnit, PayPalTracker } from "./records";
