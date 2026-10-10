export const PAYMENT_EVIDENCE_BUCKET = "payment-evidence";
export const MAX_PAYMENT_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const MAX_PAYMENT_EVIDENCE_ATTACHMENTS = 5;
export const PAYMENT_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
