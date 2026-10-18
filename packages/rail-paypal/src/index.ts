// PayPal rail: the sandbox-only REST client. It owns PayPal's JSON shapes and returns
// zod-checked records in minor units (ADR 0024).
export {
  type AddTrackerInput,
  type CreateOrderInput,
  createPayPalClient,
  type FetchLike,
  type OrderItem,
  type PayPalClient,
  type PayPalClientOptions,
  type PostOptions,
  type RefundCaptureInput,
  type VerifyWebhookInput,
  type WebhookTransmission,
} from "./client";
export {
  PAYPAL_ENV_NAMES,
  PAYPAL_WEBHOOK_ID_NAME,
  type PayPalConfig,
  PayPalConfigError,
  type PayPalEnvParse,
  type PayPalWebhookIdParse,
  parsePayPalEnv,
  parsePayPalWebhookId,
  SANDBOX_BASE_URL,
} from "./config";
export { PayPalError, type PayPalErrorDetail, type PayPalErrorKind } from "./errors";
export {
  type PayPalCapture,
  type PayPalDispute,
  type PayPalDisputeList,
  type PayPalOrder,
  type PayPalPurchaseUnit,
  type PayPalRefund,
  type PayPalRefundStatus,
  type PayPalTracker,
  REFUND_STATUSES,
  refundedTotal,
  type WebhookVerification,
} from "./records";
