"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { editShipmentDetails, voidShipment } from "@/actions/shipments";

function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ReleaseRecordActions({
  reservationId,
  shipmentId,
  shipmentNo,
  updatedAt,
  shippedAt,
  notes,
  canEdit,
  canVoid,
}: {
  reservationId: string;
  shipmentId: string;
  shipmentNo: string;
  updatedAt: string;
  shippedAt: string | null;
  notes: string | null;
  canEdit: boolean;
  canVoid: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<"edit" | "void" | null>(null);
  const [releaseDate, setReleaseDate] = useState(() => toDateTimeLocal(shippedAt));
  const [releaseNotes, setReleaseNotes] = useState(notes ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  function openEdit() {
    setReleaseDate(toDateTimeLocal(shippedAt));
    setReleaseNotes(notes ?? "");
    setReason("");
    setFeedback(null);
    setOpen("edit");
  }

  function openVoid() {
    setReason("");
    setFeedback(null);
    setOpen("void");
  }

  async function submitEdit() {
    if (!releaseDate || reason.trim().length < 3) {
      setFeedback("Release date and correction remarks are required.");
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result = await editShipmentDetails(
      reservationId,
      shipmentId,
      updatedAt,
      new Date(releaseDate).toISOString(),
      releaseNotes,
      reason,
    );
    setBusy(false);
    if (result.status === "error") {
      setFeedback(result.message);
      return;
    }
    setOpen(null);
    router.refresh();
  }

  async function submitVoid() {
    if (reason.trim().length < 3) {
      setFeedback("Void remarks are required.");
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result = await voidShipment(reservationId, shipmentId, reason);
    setBusy(false);
    if (result.status === "error") {
      setFeedback(result.message);
      return;
    }
    setOpen(null);
    router.refresh();
  }

  if (!canEdit && !canVoid) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (open) {
            setOpen(null);
          } else if (canEdit) {
            openEdit();
          } else {
            openVoid();
          }
        }}
        className="rounded-lg border border-border bg-white px-3 py-2 text-sm font-semibold text-ink hover:border-gold"
      >
        Edit
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`release-correction-${shipmentId}`}
          onClick={() => {
            if (!busy) setOpen(null);
          }}
        >
          <div
            className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-white p-5 text-left shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
          {open === "edit" ? (
            <>
              <div className="flex items-start justify-between gap-4">
                <p id={`release-correction-${shipmentId}`} className="font-semibold text-ink">Correct {shipmentNo}</p>
                <button type="button" onClick={() => setOpen(null)} disabled={busy} className="text-xl leading-none text-muted hover:text-ink">
                  ×
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">
                Update only the release date or notes. The correction reason is required.
              </p>
              <label className="mt-4 block text-sm font-semibold text-ink">
                Release date and time
                <input
                  className="mt-2 h-10 w-full rounded-lg border border-border px-3 font-normal outline-none focus:border-gold"
                  type="datetime-local"
                  value={releaseDate}
                  onChange={(event) => setReleaseDate(event.target.value)}
                  required
                />
              </label>
              <label className="mt-3 block text-sm font-semibold text-ink">
                Release notes <span className="font-normal text-muted">(optional)</span>
                <textarea
                  className="mt-2 min-h-20 w-full rounded-lg border border-border px-3 py-2 font-normal outline-none focus:border-gold"
                  maxLength={2000}
                  value={releaseNotes}
                  onChange={(event) => setReleaseNotes(event.target.value)}
                />
              </label>
              <label className="mt-3 block text-sm font-semibold text-ink">
                Correction remarks <span className="text-red-700">*</span>
                <textarea
                  className="mt-2 min-h-20 w-full rounded-lg border border-border px-3 py-2 font-normal outline-none focus:border-gold"
                  minLength={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  placeholder="Explain what was corrected"
                />
              </label>
              {feedback && <p className="mt-3 text-sm text-red-700">{feedback}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(null)} disabled={busy} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-ink">
                  Back
                </button>
                <button type="button" onClick={() => void submitEdit()} disabled={busy} className="rounded-lg bg-gold px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {busy ? "Saving…" : "Save correction"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <p id={`release-correction-${shipmentId}`} className="font-semibold text-ink">Void {shipmentNo}?</p>
                <button type="button" onClick={() => setOpen(null)} disabled={busy} className="text-xl leading-none text-muted hover:text-ink">
                  ×
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">
                This returns the released items and applied downpayment so a corrected release can be created.
              </p>
              <label className="mt-4 block text-sm font-semibold text-ink">
                Void remarks <span className="text-red-700">*</span>
                <textarea
                  className="mt-2 min-h-24 w-full rounded-lg border border-border px-3 py-2 font-normal outline-none focus:border-gold"
                  minLength={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  placeholder="Explain why this release is being voided"
                />
              </label>
              {feedback && <p className="mt-3 text-sm text-red-700">{feedback}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(null)} disabled={busy} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-ink">
                  Back
                </button>
                <button type="button" onClick={() => void submitVoid()} disabled={busy} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {busy ? "Voiding…" : "Confirm void"}
                </button>
              </div>
            </>
          )}
          {open === "edit" && canVoid && (
            <button type="button" onClick={openVoid} disabled={busy} className="mt-3 text-xs font-semibold text-red-700 hover:underline">
              Wrong item, quantity, or downpayment? Void this release
            </button>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
