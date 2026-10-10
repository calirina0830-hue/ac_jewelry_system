"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { usePaymentSubmissionPhase } from "@/components/reservations/payment-upload-form";
import {
  MAX_PAYMENT_EVIDENCE_BYTES,
  MAX_PAYMENT_EVIDENCE_ATTACHMENTS,
  PAYMENT_EVIDENCE_MIME_TYPES,
} from "@/lib/constants/payments";

export function PaymentEvidenceInput({
  name,
}: {
  name: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const phase = usePaymentSubmissionPhase();
  const busy = phase !== "idle";
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  useEffect(
    () => () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    },
    [previews],
  );

  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;

    const resetEvidence = () => {
      setFiles([]);
      setError("");
    };
    form.addEventListener("reset", resetEvidence);
    return () => form.removeEventListener("reset", resetEvidence);
  }, []);

  function syncFiles(nextFiles: File[]) {
    setFiles(nextFiles);
    setError("");
    if (inputRef.current && typeof DataTransfer !== "undefined") {
      const transfer = new DataTransfer();
      nextFiles.forEach((file) => transfer.items.add(file));
      inputRef.current.files = transfer.files;
    }
  }

  return (
    <div className="block text-sm font-semibold text-ink">
      <label htmlFor={name}>
        Evidence <span className="font-normal text-muted">(optional)</span>
      </label>
      {previews.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3" role="list">
          {previews.map((preview, index) => (
            <div className="min-w-0" key={preview.file.name + preview.file.lastModified} role="listitem">
              {/* Local object URLs do not need Next image optimization. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={"Selected evidence " + (index + 1)}
                className="aspect-square w-full rounded-xl border border-border bg-white object-cover"
                src={preview.url}
              />
              <p className="mt-1 truncate text-[11px] font-normal text-muted" title={preview.file.name}>
                {preview.file.name}
              </p>
              <button
                className="mt-1 text-xs font-bold text-red-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                disabled={busy}
                onClick={() => syncFiles(files.filter((_, fileIndex) => fileIndex !== index))}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        accept={PAYMENT_EVIDENCE_MIME_TYPES.join(",")}
        className="mt-2 block w-full text-xs font-normal text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-2 file:text-xs file:font-bold file:text-white"
        disabled={busy}
        id={name}
        multiple
        name={name}
        onChange={(event) => {
          const nextFiles = Array.from(event.target.files ?? []);
          if (nextFiles.length > MAX_PAYMENT_EVIDENCE_ATTACHMENTS) {
            setFiles([]);
            event.target.value = "";
            setError("Select no more than 5 evidence images.");
            return;
          }
          syncFiles(nextFiles);
        }}
        ref={inputRef}
        type="file"
      />
      {error && <p className="mt-2 text-xs font-semibold text-red-700" role="alert">{error}</p>}
      <span className="mt-1 block text-[11px] font-normal text-muted">
        Upload up to {MAX_PAYMENT_EVIDENCE_ATTACHMENTS} evidence images. JPEG, PNG,
        or WebP; maximum {MAX_PAYMENT_EVIDENCE_BYTES / 1024 / 1024} MB each.
      </span>
    </div>
  );
}
