"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { buildBulkPaymentHref } from "@/lib/reservations/payment-selection";

const BULK_FORM_ID = "bulk-reservation-form";

type BulkSelectionRow = {
  id: string;
  label: string;
  paymentIneligibilityReason: string | null;
};

type BulkSelectionContextValue = {
  allSelected: boolean;
  message: string;
  rows: BulkSelectionRow[];
  selectedIds: string[];
  selectAll: (checked: boolean) => void;
  setMessage: (message: string) => void;
  toggle: (id: string, checked: boolean) => void;
};

const BulkSelectionContext = createContext<BulkSelectionContextValue | null>(
  null,
);

function useBulkSelection(): BulkSelectionContextValue {
  const context = useContext(BulkSelectionContext);
  if (!context) {
    throw new Error("Bulk reservation controls require BulkSelectionProvider.");
  }
  return context;
}

export function BulkSelectionProvider({
  children,
  rows,
}: {
  children: ReactNode;
  rows: BulkSelectionRow[];
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));

  useEffect(() => {
    const resetSelection = () => {
      setSelectedIds([]);
      setMessage("");
    };
    window.addEventListener("pageshow", resetSelection);
    window.addEventListener("popstate", resetSelection);
    return () => {
      window.removeEventListener("pageshow", resetSelection);
      window.removeEventListener("popstate", resetSelection);
    };
  }, []);

  const value = useMemo<BulkSelectionContextValue>(
    () => ({
      allSelected,
      message,
      rows,
      selectedIds,
      selectAll: (checked) => {
        setSelectedIds(checked ? visibleIds : []);
        setMessage("");
      },
      setMessage,
      toggle: (id, checked) => {
        setSelectedIds((current) =>
          checked
            ? current.includes(id)
              ? current
              : [...current, id]
            : current.filter((selectedId) => selectedId !== id),
        );
        setMessage("");
      },
    }),
    [allSelected, message, rows, selectedIds, visibleIds],
  );

  return (
    <BulkSelectionContext.Provider value={value}>
      {children}
    </BulkSelectionContext.Provider>
  );
}

export function BulkRowCheckbox({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const { selectedIds, toggle } = useBulkSelection();
  return (
    <input
      aria-label={label}
      checked={selectedIds.includes(value)}
      className="size-4 accent-gold"
      form={BULK_FORM_ID}
      name="reservationIds"
      onChange={(event) => toggle(value, event.target.checked)}
      type="checkbox"
      value={value}
    />
  );
}

export function BulkSelectAll() {
  const { allSelected, selectAll } = useBulkSelection();
  return (
    <input
      aria-label="Select all reservations on this page"
      checked={allSelected}
      className="size-4 accent-gold"
      onChange={(event) => selectAll(event.target.checked)}
      type="checkbox"
    />
  );
}

export function BulkSelectionCount() {
  const { selectedIds } = useBulkSelection();
  return (
    <span
      aria-live="polite"
      className="whitespace-nowrap text-sm font-bold text-ink"
    >
      {selectedIds.length} selected
    </span>
  );
}

export function BulkSelectionMessage() {
  const { message } = useBulkSelection();
  if (!message) return null;
  return (
    <p className="text-xs font-semibold text-red-700 sm:basis-full" role="alert">
      {message}
    </p>
  );
}

export function BulkReviewButton({
  destination,
  children,
  tone = "neutral",
}: {
  destination: "pay" | "revert";
  children: ReactNode;
  tone?: "neutral" | "danger";
}) {
  const router = useRouter();
  const { rows, selectedIds, setMessage } = useBulkSelection();

  return (
    <button
      className={
        "h-10 w-full rounded-xl px-4 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto " +
        (tone === "danger"
          ? "bg-red-700 text-white"
          : "border border-border bg-white text-ink hover:border-gold")
      }
      disabled={selectedIds.length === 0}
      onClick={() => {
        if (!selectedIds.length) return;

        if (destination === "pay") {
          const selectedRows = selectedIds
            .map((id) => rows.find((row) => row.id === id))
            .filter((row): row is BulkSelectionRow => Boolean(row));
          const invalidRows = selectedRows.filter(
            (row) => row.paymentIneligibilityReason,
          );
          if (
            selectedRows.length !== selectedIds.length ||
            invalidRows.length > 0
          ) {
            const details = invalidRows
              .map(
                (row) =>
                  row.label + " (" + row.paymentIneligibilityReason + ")",
              )
              .join(", ");
            setMessage(
              "Some selected reservations cannot receive a payment." +
                (details ? " " + details + "." : ""),
            );
            return;
          }
          router.push(buildBulkPaymentHref(selectedIds));
          return;
        }

        const params = new URLSearchParams({ ids: selectedIds.join(",") });
        router.push("/reservations/bulk/revert?" + params.toString());
      }}
      type="button"
    >
      {children}
    </button>
  );
}

export function BulkSubmitButton({
  operation,
  confirmation,
  children,
  tone = "neutral",
}: {
  operation: "cancel" | "deliver";
  confirmation: string;
  children: ReactNode;
  tone?: "neutral" | "danger";
}) {
  const { selectedIds } = useBulkSelection();

  return (
    <button
      className={
        "h-10 w-full rounded-xl px-4 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto " +
        (tone === "danger"
          ? "bg-red-700 text-white"
          : "bg-ink text-white")
      }
      disabled={selectedIds.length === 0}
      name="operation"
      onClick={(event) => {
        if (!selectedIds.length) {
          event.preventDefault();
          return;
        }
        if (
          !window.confirm(
            confirmation.replace("{count}", String(selectedIds.length)),
          )
        ) {
          event.preventDefault();
        }
      }}
      type="submit"
      value={operation}
    >
      {children}
    </button>
  );
}
