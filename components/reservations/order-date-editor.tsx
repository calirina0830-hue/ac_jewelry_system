"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { setReservationItemOrderedAt } from "@/actions/shipments";
import { formatOrderDateTime } from "@/lib/format";

type OrderDateEditorProps = {
  reservationId: string;
  reservationItemId: string;
  orderedAt: string | null;
  canEdit: boolean;
};

function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

export function OrderDateEditor({
  reservationId,
  reservationItemId,
  orderedAt,
  canEdit,
}: OrderDateEditorProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() =>
    orderedAt ? toLocalInputValue(orderedAt) : "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span className={orderedAt ? "text-ink" : "text-muted"}>
          {formatOrderDateTime(orderedAt)}
        </span>
        {canEdit && (
          <button
            className="text-xs font-semibold text-gold-dark hover:underline"
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
            type="button"
          >
            {orderedAt ? "Edit" : "Set"}
          </button>
        )}
      </div>
    );
  }

  async function save() {
    if (pending || !value) return;
    setPending(true);
    setError(null);
    const result = await setReservationItemOrderedAt(
      reservationId,
      reservationItemId,
      new Date(value).toISOString(),
    );
    setPending(false);
    if (result.status === "success") {
      setEditing(false);
      router.refresh();
      return;
    }
    setError(result.message);
  }

  return (
    <div className="space-y-1.5">
      <input
        className="h-9 rounded-lg border border-border px-2 text-xs outline-none focus:border-gold"
        onChange={(event) => setValue(event.target.value)}
        type="datetime-local"
        value={value}
      />
      <div className="flex items-center gap-2">
        <button
          className="inline-flex h-8 items-center rounded-lg bg-black px-3 text-xs font-bold text-white hover:bg-neutral-800 disabled:opacity-50"
          disabled={pending || !value}
          onClick={save}
          type="button"
        >
          {pending ? "Saving..." : "Save"}
        </button>
        <button
          className="text-xs font-semibold text-muted hover:underline"
          onClick={() => {
            setEditing(false);
            setValue(orderedAt ? toLocalInputValue(orderedAt) : "");
          }}
          type="button"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
