import {
  MAX_STOCK_IMAGE_BYTES,
  STOCK_IMAGE_MIME_TYPES,
} from "@/lib/constants/stock";

type ValidatedImage = {
  body: ArrayBuffer;
  contentType: (typeof STOCK_IMAGE_MIME_TYPES)[number];
  extension: "jpg" | "png" | "webp";
};

type ImageValidationResult =
  | { success: true; image: ValidatedImage }
  | { success: false; message: string };

function hasValidSignature(
  bytes: Uint8Array,
  contentType: string,
): boolean {
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (contentType === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }

  return (
    contentType === "image/webp" &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}

export async function validateStockImage(
  file: File,
): Promise<ImageValidationResult> {
  if (file.size > MAX_STOCK_IMAGE_BYTES) {
    return { success: false, message: "Image must be 5 MB or smaller." };
  }

  if (
    !STOCK_IMAGE_MIME_TYPES.includes(
      file.type as (typeof STOCK_IMAGE_MIME_TYPES)[number],
    )
  ) {
    return {
      success: false,
      message: "Image must be a JPEG, PNG, or WebP file.",
    };
  }

  const body = await file.arrayBuffer();
  const bytes = new Uint8Array(body.slice(0, 12));

  if (!hasValidSignature(bytes, file.type)) {
    return {
      success: false,
      message: "The selected file does not contain a valid image.",
    };
  }

  const extension =
    file.type === "image/jpeg"
      ? "jpg"
      : file.type === "image/png"
        ? "png"
        : "webp";

  return {
    success: true,
    image: {
      body,
      contentType:
        file.type as (typeof STOCK_IMAGE_MIME_TYPES)[number],
      extension,
    },
  };
}

export function getStockImageUrl(path: string | null): string | null {
  if (!path) {
    return null;
  }

  return "/stock-image?path=" + encodeURIComponent(path);
}

export function isSafeStockImagePath(path: string): boolean {
  if (
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes(String.fromCharCode(92)) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    !/\.(?:jpe?g|png|webp)$/i.test(path)
  ) {
    return false;
  }

  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
