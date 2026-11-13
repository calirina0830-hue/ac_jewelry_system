"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";

import {
  createReservation,
  updateReservation,
} from "@/actions/reservations";
import { createCustomerInline } from "@/actions/customers";
import {
  FormSubmitButton,
  InputField,
  TextareaField,
} from "@/components/ui/form-elements";
import { formatCurrency, formatOrderDateTime } from "@/lib/format";
import {
  calculateReservationTotals,
  parseMoneyToCents,
} from "@/lib/reservations/money";
import { formatItemLabel } from "@/lib/reservations/item-label";
import type {
  ReservationCustomerOption,
  ReservationInitialItem,
  ReservationInitialValue,
} from "@/types/reservations";
import { INITIAL_FORM_STATE } from "@/types/forms";

type DraftItem = ReservationInitialItem & {
  key: string;
  quantityInput: string;
  // What the user sees and types; compared with originalLabel on save.
  itemLabel: string;
  originalLabel: string;
};

function createBlankItem(): DraftItem {
  return {
    key: crypto.randomUUID(),
    stockItemId: "",
    quantity: 1,
    quantityInput: "1",
    discount: "0.00",
    unitPrice: "",
    itemName: "",
    sku: "",
    category: "",
    imagePath: null,
    itemLabel: "",
    originalLabel: "",
  };
}

function createInitialItem(item: ReservationInitialItem): DraftItem {
  const label = formatItemLabel({
    sku: item.sku,
    name: item.itemName,
    category: item.category,
  });
  return {
    ...item,
    itemLabel: label,
    originalLabel: label,
    key: item.reservationItemId ?? crypto.randomUUID(),
    quantityInput: String(item.quantity),
  };
}

function getErrors(
  errors: Record<string, string[]> | undefined,
  path: string,
): string[] | undefined {
  return errors?.[path];
}

export function ReservationForm({
  customers,
  initialValue,
  mode = "page",
  cancelHref,
  returnTo,
  customerOrders,
}: {
  customers: ReservationCustomerOption[];
  initialValue?: ReservationInitialValue;
  // "modal" fits a floating window: only the item list scrolls.
  mode?: "page" | "modal";
  cancelHref?: string;
  // Where to land after saving an edit.
  returnTo?: string;
  // All of this customer's open orders, which share one downpayment figure.
  customerOrders?: {
    ids: string[];
    paid: string;
    otherOrdersTotalCents: number;
  };
}) {
  const isModal = mode === "modal";
  const action = initialValue ? updateReservation : createReservation;
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState(customers);
  const [customerId, setCustomerId] = useState(initialValue?.customerId ?? "");
  const [items, setItems] = useState<DraftItem[]>(() =>
    initialValue?.items.length
      ? initialValue.items.map(createInitialItem)
      : [createBlankItem()],
  );
  const [reservationDiscount, setReservationDiscount] = useState(
    initialValue?.reservationDiscount ?? "0.00",
  );
  // Editing starts from what the customer has actually paid. Saving a new
  // figure adjusts the payment records, so every total follows it.
  const [downpayment, setDownpayment] = useState(
    customerOrders?.paid ?? initialValue?.amountPaid ?? "0.00",
  );
  const [additionalDownpayment, setAdditionalDownpayment] = useState("");

  // Modals for inline creation
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [customerModalInitialName, setCustomerModalInitialName] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          "/reservation-options/customers",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: customerSearch }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const body = (await response.json()) as {
          options: ReservationCustomerOption[];
        };
        setCustomerOptions((current) => {
          const selected = current.find((option) => option.id === customerId);
          return selected && !body.options.some((option) => option.id === selected.id)
            ? [selected, ...body.options]
            : body.options;
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        console.error("Error fetching customer options:", error);
      }
    }, 100);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [customerId, customerSearch]);

  const normalizedCustomerSearch = customerSearch.trim().toLocaleLowerCase();
  const visibleCustomers = customerOptions.filter((customer) =>
    !normalizedCustomerSearch ||
    customer.name.toLocaleLowerCase().includes(normalizedCustomerSearch) ||
    customer.facebookName?.toLocaleLowerCase().includes(normalizedCustomerSearch),
  );
  const selectedCustomer = customerOptions.find(
    (customer) => customer.id === customerId,
  );
  const preview = calculateReservationTotals(
    [...items, ...(initialValue?.preservedItems ?? []).map(createInitialItem)].map((item) => ({
      unitPriceCents: parseMoneyToCents(item.unitPrice) ?? 0,
      quantity: /^\d+$/.test(item.quantityInput)
        ? Number(item.quantityInput)
        : 0,
      discountCents: parseMoneyToCents(item.discount) ?? 0,
    })),
    parseMoneyToCents(reservationDiscount) ?? 0,
    parseMoneyToCents(downpayment) ?? 0,
  );
  const serializedItems = JSON.stringify(
    [...items, ...(initialValue?.preservedItems ?? []).map(createInitialItem)].map((item) => ({
      // An untouched line keeps its link; a retyped line is saved as new.
      ...(item.stockItemId && item.itemLabel.trim() === item.originalLabel
        ? { reservationItemId: item.reservationItemId, stockItemId: item.stockItemId }
        : { itemName: item.itemLabel }),
      quantity: item.quantityInput,
      sellingPrice: item.unitPrice,
      discount: item.discount,
      orderedAt: item.orderedAt,
    })),
  );
  // The footer shows the whole customer, matching their row in the list.
  const customerTotalCents =
    preview.totalCents + (customerOrders?.otherOrdersTotalCents ?? 0);

  function updateItem(key: string, update: Partial<DraftItem>) {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...update } : item)),
    );
  }

  function handleOpenCustomerModal(prefill = "") {
    setCustomerModalInitialName(prefill);
    setIsCustomerModalOpen(true);
  }

  function handleCustomerCreated(newCustomer: ReservationCustomerOption) {
    setCustomerOptions((current) => [newCustomer, ...current.filter((c) => c.id !== newCustomer.id)]);
    setCustomerId(newCustomer.id);
    setCustomerSearch("");
    setIsCustomerModalOpen(false);
  }

  return (
    <>
      <form
        action={formAction}
        className={isModal ? "flex min-h-0 flex-auto flex-col gap-3" : "space-y-8"}
        noValidate
      >
        {initialValue && (
          <>
            <input name="id" type="hidden" value={initialValue.id} />
            <input
              name="updatedAt"
              type="hidden"
              value={initialValue.updatedAt}
            />
          </>
        )}
        <input name="items" type="hidden" value={serializedItems} />
        {returnTo && <input name="returnTo" type="hidden" value={returnTo} />}
        {customerOrders && (
          <input
            name="customerOrderIds"
            type="hidden"
            value={JSON.stringify(customerOrders.ids)}
          />
        )}
        {state.message && (
          <div
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            role="alert"
          >
            {state.message}
          </div>
        )}

        <section className={isModal ? "relative z-40 shrink-0" : undefined}>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-semibold text-ink">Customer</p>
            {!initialValue && (
              <button
                className="text-sm font-semibold text-gold-dark hover:underline"
                onClick={() => handleOpenCustomerModal(customerSearch)}
                type="button"
              >
                + Add customer
              </button>
            )}
          </div>
          <div className="max-w-2xl">
            <CustomerCombobox
              error={customerId ? undefined : state.fieldErrors?.customerId?.[0]}
              onAddNew={
                initialValue ? undefined : (search) => handleOpenCustomerModal(search)
              }
              onClear={() => {
                setCustomerId("");
                setCustomerSearch("");
              }}
              onSearch={setCustomerSearch}
              onSelect={(customer) => {
                setCustomerId(customer.id);
                setCustomerSearch("");
              }}
              options={visibleCustomers}
              search={customerSearch}
              selected={selectedCustomer}
            />
          <label className="hidden" htmlFor="customerId">
            Customer identifier
            <select
              aria-describedby={state.fieldErrors?.customerId ? "customerId-error" : undefined}
              aria-invalid={Boolean(state.fieldErrors?.customerId)}
              className={
                "mt-2 block h-12 w-full rounded-xl border bg-white px-4 text-[15px] font-normal text-ink outline-none transition focus:border-gold focus:ring-4 focus:ring-gold/10 " +
                (state.fieldErrors?.customerId ? "border-red-400" : "border-border")
              }
              id="customerId"
              name="customerId"
              onChange={(event) => setCustomerId(event.target.value)}
              required
              value={customerId}
            >
              <option value="">Choose an active customer</option>
              {visibleCustomers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.facebookName
                    ? customer.facebookName + " — " + customer.name
                    : customer.name}
                </option>
              ))}
            </select>
            {state.fieldErrors?.customerId?.map((error) => (
              <span
                className="mt-1.5 block text-xs font-normal text-red-700"
                id="customerId-error"
                key={error}
              >
                {error}
              </span>
            ))}
          </label>
        </div>
      </section>

      <section className={isModal ? "flex min-h-0 flex-auto flex-col" : undefined}>
        <p className="text-sm font-semibold text-ink">Items</p>

        {state.fieldErrors?.items?.map((error) => (
          <p className="mt-4 text-sm font-medium text-red-700" key={error} role="alert">
            {error}
          </p>
        ))}

        {(initialValue?.preservedItems?.length ?? 0) > 0 && (
          <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
            {initialValue?.preservedItems?.length} fully released item
            {initialValue?.preservedItems?.length === 1 ? " is" : "s are"} hidden
            from editing and safely preserved in the reservation history.
          </p>
        )}

        <div className={"mt-1 hidden gap-2 border-b border-border pb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted md:grid md:grid-cols-[minmax(0,1fr)_112px_64px_96px_104px_24px]"}>
          <span>Item</span>
          <span>Price</span>
          <span>Qty</span>
          <span>Discount</span>
          <span className="text-right">Total</span>
          <span />
        </div>
        <div
          className={
            isModal
              ? "min-h-0 flex-auto overflow-y-auto"
              : undefined
          }
        >
          {items.map((item, index) => {
            const itemNameError = getErrors(
              state.fieldErrors,
              "items." + index + ".itemName",
            );
            const sellingPriceError =
              item.unitPrice !== "" && parseMoneyToCents(item.unitPrice) !== null
                ? undefined
                : getErrors(
                    state.fieldErrors,
                    "items." + index + ".sellingPrice",
                  );
            const discountError =
              item.discount === "" || parseMoneyToCents(item.discount) !== null
                ? undefined
                : getErrors(state.fieldErrors, "items." + index + ".discount");
            const quantityError = getErrors(
              state.fieldErrors,
              "items." + index + ".quantity",
            );

            return (
              <div
                className={"grid gap-2 border-b border-border/70 py-2.5 md:items-start md:grid-cols-[minmax(0,1fr)_112px_64px_96px_104px_24px]"}
                key={item.key}
              >
                  <label className="block min-w-0 text-sm font-semibold text-ink">
                    <span className="md:sr-only">Item</span>
                    <input
                      aria-invalid={Boolean(itemNameError)}
                      className={
                        "mt-1 block h-10 w-full rounded-xl border bg-white px-3 text-sm font-normal text-ink outline-none read-only:bg-canvas focus:border-gold focus:ring-4 focus:ring-gold/10 md:mt-0 " +
                        (itemNameError ? "border-red-400" : "border-border")
                      }
                      maxLength={160}
                      onChange={(event) =>
                        updateItem(item.key, { itemLabel: event.target.value })
                      }
                      placeholder="Type the item"
                      readOnly={Boolean(item.nameLocked)}
                      title={
                        item.nameLocked
                          ? "Part of this item is already released, so its name cannot change."
                          : undefined
                      }
                      type="text"
                      value={item.itemLabel}
                    />
                    {item.orderedAt && (
                      <span className="mt-1 block text-[11px] font-normal text-muted">
                        Ordered: {formatOrderDateTime(item.orderedAt)}
                      </span>
                    )}
                    {itemNameError?.map((error) => (
                      <span className="mt-1.5 block text-xs text-red-700" key={error}>
                        {error}
                      </span>
                    ))}
                  </label>

                  <label className="block text-sm font-semibold text-ink">
                    <span className="md:sr-only">Selling price</span>
                    <input
                      aria-invalid={Boolean(sellingPriceError)}
                      className="mt-1 block h-10 md:mt-0 w-full rounded-xl border border-border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
                      inputMode="decimal"
                      min="0"
                      onChange={(event) =>
                        updateItem(item.key, { unitPrice: event.target.value })
                      }
                      placeholder="Enter selling price"
                      required
                      step="0.01"
                      type="number"
                      value={item.unitPrice}
                    />
                    {sellingPriceError?.map((error) => (
                      <span
                        className="mt-1.5 block text-xs text-red-700"
                        key={error}
                      >
                        {error}
                      </span>
                    ))}
                  </label>

                  <label className="block text-sm font-semibold text-ink">
                    <span className="md:sr-only">Quantity</span>
                    <input
                      aria-invalid={Boolean(quantityError)}
                      className={
                        "mt-1 block h-10 md:mt-0 w-full rounded-xl border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 " +
                        (quantityError ? "border-red-400" : "border-border")
                      }
                      inputMode="numeric"
                      min="1"
                      onChange={(event) =>
                        updateItem(item.key, {
                          quantity: Number(event.target.value) || 0,
                          quantityInput: event.target.value,
                        })
                      }
                      required
                      step="1"
                      type="number"
                      value={item.quantityInput}
                    />
                    {quantityError?.map((error) => (
                      <span className="mt-1.5 block text-xs text-red-700" key={error}>
                        {error}
                      </span>
                    ))}
                  </label>

                  <label className="block text-sm font-semibold text-ink">
                    <span className="md:sr-only">Discount</span>
                    <input
                      aria-invalid={Boolean(discountError)}
                      className={
                        "mt-1 block h-10 md:mt-0 w-full rounded-xl border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 " +
                        (discountError ? "border-red-400" : "border-border")
                      }
                      inputMode="decimal"
                      min="0"
                      onChange={(event) =>
                        updateItem(item.key, { discount: event.target.value })
                      }
                      step="0.01"
                      type="number"
                      value={item.discount}
                    />
                    {discountError?.map((error) => (
                      <span className="mt-1.5 block text-xs text-red-700" key={error}>
                        {error}
                      </span>
                    ))}
                  </label>

                  <div className="flex items-center justify-between md:h-10 md:justify-end">
                    <span className="text-sm font-semibold text-ink md:sr-only">Line total</span>
                    <span className="text-sm font-bold tabular-nums text-ink">
                      {formatCurrency(preview.lines[index]?.lineTotalCents / 100 || 0)}
                    </span>
                  </div>
                  <div className="flex justify-end md:h-10 md:items-center">
                    {items.length > 1 && (
                      <button
                        aria-label={"Remove item " + (index + 1)}
                        className="text-lg font-bold leading-none text-muted hover:text-red-700"
                        onClick={() =>
                          setItems((current) =>
                            current.filter((candidate) => candidate.key !== item.key),
                          )
                        }
                        title="Remove item"
                        type="button"
                      >
                        ×
                      </button>
                    )}
                  </div>
              </div>
            );
          })}
        </div>
        <button
          className="mt-2 w-fit shrink-0 text-sm font-bold text-gold-dark hover:underline"
          onClick={() => setItems((current) => [...current, createBlankItem()])}
          type="button"
        >
          + Add another item
        </button>
      </section>

      <details className="group shrink-0" open={Boolean(initialValue?.notes)}>
        <summary className="cursor-pointer list-none text-sm font-semibold text-gold-dark hover:underline">
          <span className="group-open:hidden">+ Add a note</span>
          <span className="hidden group-open:inline">Notes</span>
        </summary>
        <div className="mt-2 max-w-2xl">
          <TextareaField
            defaultValue={initialValue?.notes ?? ""}
            errors={state.fieldErrors?.notes}
            label="Reservation notes"
            maxLength={4000}
            name="notes"
            placeholder="Sizing, pickup arrangements, or other reservation details"
            rows={3}
          />
        </div>
      </details>

        <div
          className={
            isModal
              ? "-mx-5 flex shrink-0 flex-wrap items-end gap-x-5 gap-y-3 rounded-b-2xl border-t border-border bg-white px-5 py-3"
              : "sticky bottom-0 z-30 -mx-5 flex flex-wrap items-end gap-x-5 gap-y-3 border-t border-border bg-white px-5 py-3 sm:-mx-8 sm:px-8"
          }
        >
          <div className="w-32">
            <InputField
              errors={state.fieldErrors?.reservationDiscount}
              inputMode="decimal"
              label="Order discount"
              min="0"
              name="reservationDiscount"
              onChange={(event) => setReservationDiscount(event.target.value)}
              step="0.01"
              type="number"
              value={reservationDiscount}
            />
          </div>
          <div className="w-32">
            <InputField
              errors={state.fieldErrors?.downpayment}
              inputMode="decimal"
              label="Downpayment"
              min="0"
              name="downpayment"
              onChange={(event) => setDownpayment(event.target.value)}
              step="0.01"
              type="number"
              value={downpayment}
            />
          </div>
          {initialValue && (
            <div className="w-32">
              <InputField
                errors={state.fieldErrors?.additionalDownpayment}
                inputMode="decimal"
                label="Add downpayment"
                min="0"
                name="additionalDownpayment"
                onChange={(event) => setAdditionalDownpayment(event.target.value)}
                placeholder="0.00"
                step="0.01"
                type="number"
                value={additionalDownpayment}
              />
            </div>
          )}
          <div className="pb-1 text-sm">
            <p className="text-muted">Total</p>
            <p className="font-bold tabular-nums text-ink">
              {formatCurrency(customerTotalCents / 100)}
            </p>
          </div>
          <div className="pb-1 text-sm">
            <p className="text-muted">Balance</p>
            <p className="font-bold tabular-nums text-ink">
              {formatCurrency(
                Math.max(
                  customerTotalCents -
                    (parseMoneyToCents(downpayment) ?? 0) -
                    (parseMoneyToCents(additionalDownpayment.trim() || "0") ?? 0),
                  0,
                ) / 100,
              )}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Link
              className="inline-flex h-11 items-center rounded-xl px-3 text-sm font-semibold text-muted hover:text-ink"
              href={
                cancelHref ?? "/reservations"
              }
              scroll={!isModal}
            >
              Cancel
            </Link>
            <FormSubmitButton>
              {initialValue ? "Save" : "Create reservation"}
            </FormSubmitButton>
          </div>
        </div>
      </form>

      {isCustomerModalOpen && (
        <InlineCustomerModal
          initialName={customerModalInitialName}
          onClose={() => setIsCustomerModalOpen(false)}
          onSuccess={handleCustomerCreated}
        />
      )}

    </>
  );
}

function InlineCustomerModal({
  initialName,
  onClose,
  onSuccess,
}: {
  initialName: string;
  onClose: () => void;
  onSuccess: (customer: ReservationCustomerOption) => void;
}) {
  const [name, setName] = useState(initialName);
  const [facebookName, setFacebookName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await createCustomerInline({
        name,
        facebookName,
        phone,
        address,
        notes,
      });

      if (!result.success) {
        setError(result.message);
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        return;
      }

      onSuccess({
        id: result.customer.id,
        name: result.customer.name,
        facebookName: result.customer.facebookName,
        phone: phone || null,
      });
    } catch (err) {
      console.error(err);
      setError("An unexpected error occurred while creating the customer.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <h3 className="font-serif text-xl font-bold text-ink">Add New Customer</h3>
          <button
            className="text-muted hover:text-ink text-xl leading-none"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <InputField
            autoFocus
            errors={fieldErrors.name}
            label="Customer Name *"
            name="name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Full Name"
            required
            value={name}
          />

          <InputField
            errors={fieldErrors.facebookName}
            label="Facebook / CS Name (optional)"
            name="facebookName"
            onChange={(e) => setFacebookName(e.target.value)}
            placeholder="Facebook handle or Livestream screen name"
            value={facebookName}
          />

          <InputField
            errors={fieldErrors.phone}
            label="Phone Number (optional)"
            name="phone"
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09171234567"
            value={phone}
          />

          <TextareaField
            errors={fieldErrors.address}
            label="Address (optional)"
            name="address"
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Delivery address"
            rows={2}
            value={address}
          />

          <TextareaField
            errors={fieldErrors.notes}
            label="Notes (optional)"
            name="notes"
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Customer preferences or remarks"
            rows={2}
            value={notes}
          />

          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            <button
              className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-ink hover:bg-canvas"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-xl bg-gold px-5 py-2 text-sm font-bold text-ink shadow transition hover:bg-gold-light disabled:opacity-50"
              disabled={loading}
              type="submit"
            >
              {loading ? "Saving..." : "Save Customer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CustomerCombobox({
  search,
  selected,
  options,
  error,
  onSearch,
  onSelect,
  onClear,
  onAddNew,
}: {
  search: string;
  selected?: ReservationCustomerOption;
  options: ReservationCustomerOption[];
  error?: string;
  onSearch: (value: string) => void;
  onSelect: (option: ReservationCustomerOption) => void;
  onClear: () => void;
  onAddNew?: (search: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(!selected);
  const [activeIndex, setActiveIndex] = useState(0);
  const showingSelection = Boolean(selected && !changing);

  function beginChange() {
    onSearch("");
    setActiveIndex(0);
    setChanging(true);
    setOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function select(option: ReservationCustomerOption) {
    onSelect(option);
    setChanging(false);
    setOpen(false);
  }

  return (
    <div
      className={"relative " + (open ? "z-[80]" : "z-20")}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          if (selected) setChanging(false);
        }
      }}
      ref={rootRef}
    >
      {showingSelection ? (
        <div
          className={
            "mt-2 flex min-h-14 items-center gap-3 rounded-xl border bg-white px-4 py-2 " +
            (error ? "border-red-400" : "border-border")
          }
        >
          <button
            className="min-w-0 flex-1 text-left"
            onClick={beginChange}
            type="button"
          >
            <span className="block truncate text-sm font-bold text-ink">
              {selected?.name}
            </span>
            <span className="block truncate text-xs text-muted">
              {selected?.facebookName
                ? "FB/CS: " + selected.facebookName
                : "No FB / CS name"}
            </span>
          </button>
          <button
            className="shrink-0 text-xs font-bold text-gold-dark hover:underline"
            onClick={() => {
              onClear();
              setChanging(true);
              setOpen(true);
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
            type="button"
          >
            Clear / change
          </button>
        </div>
      ) : (
        <input
          aria-activedescendant={
            open && options[activeIndex]
              ? "customer-option-" + options[activeIndex].id
              : undefined
          }
          aria-controls="customer-options"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={Boolean(error)}
          autoComplete="off"
          className={
            "mt-2 block h-12 w-full rounded-xl border bg-white px-4 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 " +
            (error ? "border-red-400" : "border-border")
          }
          onChange={(event) => {
            setActiveIndex(0);
            onSearch(event.target.value);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) =>
                Math.min(current + 1, Math.max(options.length - 1, 0)),
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter" && open && options[activeIndex]) {
              event.preventDefault();
              select(options[activeIndex]);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="Search customer name or FB / CS name..."
          ref={inputRef}
          role="combobox"
          type="search"
          value={search}
        />
      )}
      {error && (
        <span className="mt-1.5 block text-xs text-red-700" role="alert">
          {error}
        </span>
      )}
      {open && !showingSelection && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-white p-1 shadow-xl"
          id="customer-options"
          role="listbox"
        >
          {onAddNew && search.trim() && (
            <button
              className="flex w-full items-center gap-2 rounded-lg border-b border-border/50 px-3 py-2.5 text-left font-semibold text-gold-dark hover:bg-gold-soft"
              onClick={() => {
                setOpen(false);
                onAddNew(search.trim());
              }}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <span className="text-base leading-none">+</span>
              <span className="text-xs">Create customer &quot;{search.trim()}&quot;</span>
            </button>
          )}
          {options.length ? (
            options.map((option, optionIndex) => (
              <button
                aria-selected={option.id === selected?.id}
                className={
                  "block w-full rounded-lg px-3 py-2 text-left hover:bg-canvas " +
                  (optionIndex === activeIndex ? "bg-canvas" : "")
                }
                id={"customer-option-" + option.id}
                key={option.id}
                onClick={() => select(option)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(optionIndex)}
                role="option"
                type="button"
              >
                <span className="block truncate text-sm font-semibold text-ink">
                  {option.name}
                </span>
                <span className="block truncate text-xs text-muted">
                  {option.facebookName
                    ? "FB/CS: " + option.facebookName
                    : "No FB / CS name"}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-muted">No matching customers.</p>
              {onAddNew && (
                <button
                  className="mt-2 text-xs font-bold text-gold-dark hover:underline"
                  onClick={() => {
                    setOpen(false);
                    onAddNew(search.trim());
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  + Add &quot;{search.trim() || "New Customer"}&quot; now
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
