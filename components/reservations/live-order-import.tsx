"use client";

import { useRef, useState } from "react";
import Link from "next/link";

import { saveImportProducts } from "@/actions/stock";
import { STOCK_CATEGORIES, type StockCategory } from "@/lib/constants/stock";
import type {
  LiveImportPreview,
  LiveImportResult,
} from "@/lib/import/live-orders";

const LIVE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

type ConfirmResult = {
  batchId: string;
  reservationCount: number;
  itemCount: number;
  newCustomerCount: number;
  totalValue: number | string;
};

const RESULT_STYLES: Record<LiveImportResult, string> = {
  "Ready": "bg-emerald-50 text-emerald-700",
  "New Customer": "bg-gold-soft text-gold-dark",
  "New Product": "bg-blue-50 text-blue-700",
  "Invalid Price": "bg-red-50 text-red-700",
  "Invalid Downpayment": "bg-red-50 text-red-700",
  "Invalid Quantity": "bg-red-50 text-red-700",
  "Item Not Found": "bg-red-50 text-red-700",
  "Item Ambiguous": "bg-red-50 text-red-700",
  "Invalid Customer": "bg-red-50 text-red-700",
};

// Preview shows the normalized amount clearly, e.g. imported "2,100" or
// "₱2,100" renders as ₱2,100.00.
function formatPeso(amount: number): string {
  return (
    "₱" +
    amount.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function LiveOrderImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LiveImportPreview | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"preview" | "confirm" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [savingProducts, setSavingProducts] = useState(false);
  const [productFeedback, setProductFeedback] = useState<string | null>(null);
  const [editedProducts, setEditedProducts] = useState<
    Record<string, { name: string; category: StockCategory }>
  >({});

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setPreview(null);
    setConfirmed(null);
    setError("");
    setProductFeedback(null);
    setEditedProducts({});
  }

  async function handleSaveNewProducts() {
    if (!preview || !preview.detectedNewProducts.length) return;
    setSavingProducts(true);
    setProductFeedback(null);
    setError("");

    try {
      const productsToSave = preview.detectedNewProducts.map((p) => {
        const edits = editedProducts[p.sku];
        return {
          sku: p.sku,
          name: edits?.name?.trim() || p.name.trim(),
          category: edits?.category || p.category,
          price: p.price,
          initialQuantity: p.initialQuantity,
        };
      });

      const invalid = productsToSave.find((p) => p.name.length < 2);
      if (invalid) {
        throw new Error(`Product ${invalid.sku} requires a name of at least 2 characters.`);
      }

      const res = await saveImportProducts(productsToSave);
      if (!res.success) {
        throw new Error(res.message || "Failed to save products to stock.");
      }

      setProductFeedback(
        `Successfully saved ${res.createdCount ?? productsToSave.length} product(s) to Stock! Refreshing preview...`,
      );
      await submit("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save products to stock.");
    } finally {
      setSavingProducts(false);
    }
  }

  async function submit(endpoint: "preview" | "confirm") {
    if (!file) {
      setError("Choose a CSV or XLSX file.");
      return;
    }
    if (file.size > LIVE_IMPORT_MAX_BYTES) {
      setError("The import file must be 5 MB or smaller.");
      return;
    }

    setBusy(endpoint);
    setError("");
    const formData = new FormData();
    formData.set("file", file);

    try {
      const response = await fetch("/reservations/import/" + endpoint, {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        error?: string;
        preview?: LiveImportPreview;
        result?: ConfirmResult;
      };
      if (!response.ok) throw new Error(payload.error ?? "The request failed.");

      if (endpoint === "preview" && payload.preview) {
        setPreview(payload.preview);
        const initialEdits: Record<string, { name: string; category: StockCategory }> = {};
        for (const item of payload.preview.detectedNewProducts) {
          initialEdits[item.sku] = { name: item.name, category: item.category };
        }
        setEditedProducts(initialEdits);
        setConfirmed(null);
      } else if (endpoint === "confirm" && payload.result) {
        setConfirmed(payload.result);
        setPreview(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy(null);
    }
  }

  if (confirmed) {
    return (
      <section className="mt-8 rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-card">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">
          Import complete
        </p>
        <h2 className="mt-2 font-serif text-3xl text-ink">
          Live orders are now Reserved
        </h2>
        <p className="mt-2 text-sm leading-6 text-emerald-900">
          {confirmed.reservationCount} reservations and {confirmed.itemCount} items
          were created atomically with the prices and downpayments from
          your file, dated at import time. Downpayments greater than zero were recorded in the payment
          ledger.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link className="rounded-xl bg-ink px-5 py-3 text-sm font-bold text-white" href="/reservations?status=reserved">
            View Reserved
          </Link>
          <button
            className="rounded-xl border border-emerald-300 bg-white px-5 py-3 text-sm font-bold text-emerald-800"
            onClick={() => {
              chooseFile(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            type="button"
          >
            Import another file
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <section className="rounded-3xl border border-border bg-white p-6 shadow-card">
        <div className="flex items-start gap-4">
          <Step number="1" title="Upload" active={!preview} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-serif text-2xl text-ink">Choose the live order file</h2>
                <p className="mt-1 text-sm text-muted">
                  CSV or XLSX, up to 5 MB and 2,000 order rows.
                </p>
              </div>
              <Link
                className="rounded-xl border border-border px-4 py-2.5 text-sm font-bold text-ink hover:border-gold"
                href="/reservations/import/template"
              >
                Download Template
              </Link>
            </div>

            <button
              className={
                "mt-5 flex w-full flex-col items-center rounded-2xl border-2 border-dashed px-6 py-9 text-center transition " +
                (dragging ? "border-gold bg-gold-soft/40" : "border-border bg-canvas hover:border-gold")
              }
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                chooseFile(event.dataTransfer.files[0] ?? null);
              }}
              type="button"
            >
              <span className="text-sm font-bold text-ink">
                {file ? file.name : "Drop a file here or choose a file"}
              </span>
              <span className="mt-1 text-xs text-muted">
                {file ? Math.ceil(file.size / 1024) + " KB selected" : "The original file stays selected through confirmation."}
              </span>
            </button>
            <input
              accept=".csv,.xlsx"
              className="sr-only"
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              ref={inputRef}
              type="file"
            />

            <button
              className="mt-5 rounded-xl bg-ink px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!file || busy !== null}
              onClick={() => void submit("preview")}
              type="button"
            >
              {busy === "preview" ? "Validating..." : preview ? "Refresh Preview" : "Preview"}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {preview && (
        <>
          <section className="rounded-3xl border border-border bg-white p-6 shadow-card">
            <div className="flex items-start gap-4">
              <Step number="2" title="Preview" active />
              <div className="min-w-0 flex-1">
                <h2 className="font-serif text-2xl text-ink">Validation summary</h2>
                <p className="mt-1 break-all text-xs text-muted">{preview.fileName}</p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Summary label="Rows uploaded" value={preview.summary.rowsUploaded} />
                  <Summary label="Valid rows" value={preview.summary.validRows} good />
                  <Summary label="Invalid rows" value={preview.summary.invalidRows} alert={preview.summary.invalidRows > 0} />
                  <Summary label="Existing customers" value={preview.summary.existingCustomers} />
                  <Summary label="New customers" value={preview.summary.newCustomers} />
                  <Summary label="New products" value={preview.summary.newProducts} />
                  <Summary label="Reservations" value={preview.summary.reservationsToCreate} />
                  <Summary label="Quantity" value={preview.summary.itemsToCreate} />
                </div>
              </div>
            </div>
          </section>

          {preview.detectedNewProducts.length > 0 && (
            <section className="rounded-3xl border border-blue-200 bg-blue-50/50 p-6 shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
                    Detected New Products
                  </p>
                  <h3 className="mt-1 font-serif text-xl text-ink">
                    {preview.detectedNewProducts.length} new product{preview.detectedNewProducts.length > 1 ? "s" : ""} will be added to Stock
                  </h3>
                  <p className="mt-1 text-xs text-muted">
                    Review and verify product names and categories before completing the reservation.
                  </p>
                </div>
                <button
                  className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-blue-700 disabled:opacity-50"
                  disabled={savingProducts || busy !== null}
                  onClick={handleSaveNewProducts}
                  type="button"
                >
                  {savingProducts ? "Saving to Stock..." : "Save All to Stock Now"}
                </button>
              </div>

              {productFeedback && (
                <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-100/60 p-3 text-xs font-semibold text-emerald-800">
                  {productFeedback}
                </div>
              )}

              <div className="mt-4 divide-y divide-blue-200/60 overflow-hidden rounded-2xl border border-blue-200 bg-white">
                {preview.detectedNewProducts.map((p) => {
                  const current = editedProducts[p.sku] ?? { name: p.name, category: p.category };
                  return (
                    <div className="flex flex-wrap items-center gap-4 p-4" key={p.sku}>
                      <span className="inline-flex rounded-lg bg-blue-100 px-2.5 py-1 font-mono text-xs font-bold text-blue-800">
                        {p.sku}
                      </span>
                      <div className="min-w-[200px] flex-1">
                        <label className="text-xs font-medium text-muted">Product Name</label>
                        <input
                          className="mt-1 block h-9 w-full rounded-lg border border-border px-3 text-xs text-ink outline-none focus:border-gold"
                          value={current.name}
                          onChange={(e) =>
                            setEditedProducts((prev) => ({
                              ...prev,
                              [p.sku]: { ...current, name: e.target.value },
                            }))
                          }
                          placeholder="Product Name (required)"
                        />
                      </div>
                      <div className="w-[140px]">
                        <label className="text-xs font-medium text-muted">Category</label>
                        <select
                          className="mt-1 block h-9 w-full rounded-lg border border-border px-2 text-xs text-ink outline-none focus:border-gold"
                          value={current.category}
                          onChange={(e) =>
                            setEditedProducts((prev) => ({
                              ...prev,
                              [p.sku]: { ...current, category: e.target.value as StockCategory },
                            }))
                          }
                        >
                          {STOCK_CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="text-right text-xs">
                        <p className="text-muted">Quantity: <span className="font-bold text-ink">{p.initialQuantity}</span></p>
                        <p className="text-muted">Price: <span className="font-bold text-ink">{formatPeso(p.price)}</span></p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.12em] text-muted">
                  <tr>
                    {["Row", "FB Name", "Item Code", "Item Name", "Quantity", "Price", "Downpayment", "Result"].map((label) => (
                      <th className="px-4 py-4 font-bold" key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.rows.map((row) => (
                    <tr className={row.valid ? "" : "bg-red-50/30"} key={row.rowNumber}>
                      <td className="px-4 py-4 text-sm text-muted">{row.rowNumber}</td>
                      <td className="px-4 py-4 text-sm font-semibold text-ink">{row.facebookName || "—"}</td>
                      <td className="px-4 py-4 font-mono text-xs text-ink">{row.itemCode || "—"}</td>
                      <td className="px-4 py-4 text-sm text-ink">{row.itemName || row.catalogItemName || "—"}</td>
                      <td className="px-4 py-4 text-sm tabular-nums text-ink">
                        {row.mergedQuantity || 1}
                        {row.mergedFromRows > 1 ? (
                          <span className="ml-2 text-xs text-muted">
                            merged from {row.mergedFromRows} rows
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-sm tabular-nums text-ink">
                        {row.unitPrice !== null
                          ? formatPeso(row.unitPrice)
                          : row.price || "—"}
                      </td>
                      <td className="px-4 py-4 text-sm text-ink">
                        {row.downpaymentTotal !== null
                          ? formatPeso(row.downpaymentTotal)
                          : row.downpayment || "—"}
                      </td>
                      <td className="px-4 py-4">
                        <span className={"inline-flex rounded-full px-2.5 py-1 text-xs font-bold " + RESULT_STYLES[row.result]}>
                          {row.result}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-3xl border border-border bg-white p-6 shadow-card">
            <div className="flex items-start gap-4">
              <Step number="3" title="Confirm" active={preview.summary.invalidRows === 0} />
              <div className="flex min-w-0 flex-1 flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="font-serif text-2xl text-ink">Confirm Import</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                    Creates {preview.summary.reservationsToCreate} Reserved reservations,
                    {preview.summary.itemsToCreate} item units, and {preview.summary.newCustomers} new customers
                    using the selling prices from your file. Quantity defaults
                    to 1 when blank and line totals multiply price by quantity.
                    Repeated rows with the same customer, item, and price merge
                    into one line with a combined quantity. Catalog status is
                    checked again inside one database transaction. Downpayment
                    is optional: blank or zero records nothing, while amounts
                    greater than zero are recorded through the payment ledger
                    and the reservation stays Reserved until fully settled.
                  </p>
                </div>
                <button
                  className="shrink-0 rounded-xl bg-gold px-6 py-3 text-sm font-black text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={preview.summary.invalidRows > 0 || busy !== null}
                  onClick={() => void submit("confirm")}
                  type="button"
                >
                  {busy === "confirm" ? "Importing..." : "Confirm Import"}
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Step({ number, title, active }: { number: string; title: string; active: boolean }) {
  return (
    <div className="shrink-0 text-center">
      <span className={"grid size-10 place-items-center rounded-full text-sm font-black " + (active ? "bg-ink text-white" : "bg-stone-100 text-muted")}>{number}</span>
      <span className="mt-1 block text-[10px] font-bold uppercase tracking-wider text-muted">{title}</span>
    </div>
  );
}

function Summary({ label, value, good = false, alert = false }: { label: string; value: number | string; good?: boolean; alert?: boolean }) {
  return (
    <div className={"rounded-2xl border p-4 " + (alert ? "border-red-200 bg-red-50" : good ? "border-emerald-200 bg-emerald-50" : "border-border bg-canvas")}>
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-1 text-xl font-black text-ink">{value}</p>
    </div>
  );
}
