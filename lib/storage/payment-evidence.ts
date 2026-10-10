import {
  MAX_PAYMENT_EVIDENCE_BYTES,
  PAYMENT_EVIDENCE_MIME_TYPES,
} from "@/lib/constants/payments";

type ValidatedEvidence =
  | {
      success: true;
      evidence: {
        body: ArrayBuffer;
        contentType: (typeof PAYMENT_EVIDENCE_MIME_TYPES)[number];
        extension: "jpg" | "png" | "webp";
      };
    }
  | { success: false; message: string };

type PaymentEvidenceSource = Pick<File, "arrayBuffer" | "size" | "type">;

export type PaymentEvidenceMetadata = {
  storage_path: string;
  original_file_name: string;
  mime_type: (typeof PAYMENT_EVIDENCE_MIME_TYPES)[number];
  file_size: number;
};

export type PaymentEvidenceExtension = "jpg" | "png" | "webp";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PAYMENT_EVIDENCE_METADATA_PREFIX = "evidenceMetadata:";

export function getPaymentEvidenceMetadataFieldName(
  reservationId: string,
): string {
  return PAYMENT_EVIDENCE_METADATA_PREFIX + reservationId;
}

export function buildPaymentEvidencePath(
  userId: string,
  reservationId: string,
  objectId: string,
  extension: PaymentEvidenceExtension,
): string {
  if (
    !UUID_PATTERN.test(userId) ||
    !UUID_PATTERN.test(reservationId) ||
    !UUID_PATTERN.test(objectId)
  ) {
    throw new Error("Invalid payment evidence path identifier.");
  }

  return userId + "/" + reservationId + "/" + objectId + "." + extension;
}

export function isExpectedPaymentEvidenceUploadPath(
  path: string,
  userId: string,
  reservationId: string,
  mimeType?: string,
): boolean {
  const segments = path.split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== userId ||
    segments[1] !== reservationId ||
    !UUID_PATTERN.test(segments[0]) ||
    !UUID_PATTERN.test(segments[1])
  ) {
    return false;
  }

  const fileMatch = segments[2].match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp)$/i,
  );
  if (!fileMatch || !UUID_PATTERN.test(fileMatch[1])) return false;

  if (!mimeType) return true;
  const expectedExtension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/webp"
          ? "webp"
          : null;
  return expectedExtension === fileMatch[2].toLowerCase();
}

export function sanitizePaymentEvidenceFileName(
  name: string,
  extension: PaymentEvidenceExtension,
): string {
  return (
    name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 255) ||
    "payment-evidence." + extension
  );
}

export function isSafePaymentEvidencePath(path: string): boolean {
  return (
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes(String.fromCharCode(92)) &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    /\.(?:jpe?g|png|webp)$/i.test(path) &&
    path
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export function getPaymentEvidenceUrl(path: string | null): string | null {
  return path ? "/payment-evidence?path=" + encodeURIComponent(path) : null;
}

export async function validatePaymentEvidence(
  file: PaymentEvidenceSource,
): Promise<ValidatedEvidence> {
  if (file.size > MAX_PAYMENT_EVIDENCE_BYTES) {
    return { success: false, message: "Evidence image must be 5 MB or smaller." };
  }
  if (
    !PAYMENT_EVIDENCE_MIME_TYPES.includes(
      file.type as (typeof PAYMENT_EVIDENCE_MIME_TYPES)[number],
    )
  ) {
    return {
      success: false,
      message: "Evidence must be a JPEG, PNG, or WebP image.",
    };
  }

  const body = await file.arrayBuffer();
  const bytes = new Uint8Array(body.slice(0, 12));
  const valid =
    (file.type === "image/jpeg" &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (file.type === "image/png" &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a) ||
    (file.type === "image/webp" &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP");

  if (!valid) {
    return {
      success: false,
      message: "The selected file does not contain a valid image.",
    };
  }

  return {
    success: true,
    evidence: {
      body,
      contentType:
        file.type as (typeof PAYMENT_EVIDENCE_MIME_TYPES)[number],
      extension:
        file.type === "image/jpeg"
          ? "jpg"
          : file.type === "image/png"
            ? "png"
            : "webp",
    },
  };
}
