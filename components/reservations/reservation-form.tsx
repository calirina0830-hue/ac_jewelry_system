"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";

import {
  createReservation,
  updateReservation,
} from "@/actions/reservations";
import { createCustomerInline } from "@/actions/customers";
import { createStockItemInline } from "@/actions/stock";
import { StockImage } from "@/components/stock/stock-image";
import {
  FormSubmitButton,
  InputField,
  SelectField,
  TextareaField,
} from "@/components/ui/form-elements";
import { STOCK_CATEGORIES, type StockCategory } from "@/lib/constants/stock";
import { formatCurrency } from "@/lib/format";
import {
  calculateReservationTotals,
  parseMoneyToCents,
} from "@/lib/reservations/money";
import { getStockImageUrl } from "@/lib/storage/stock-images";
import type {
  ReservationCustomerOption,
  ReservationInitialItem,
  ReservationInitialValue,
  ReservationStockOption,
} from "@/types/reservations";
import { INITIAL_FORM_STATE } from "@/types/forms";

type DraftItem = ReservationInitialItem & {
  key: string;
  quantityInput: string;
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
    imagePath: null,
  };
}

function createInitialItem(item: ReservationInitialItem): DraftItem {
  return {
    ...item,
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
  stockItems,
  initialValue,
}: {
  customers: ReservationCustomerOption[];
  stockItems: ReservationStockOption[];
  initialValue?: ReservationInitialValue;
}) {
  const action = initialValue ? updateReservation : createReservation;
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState(customers);
  const [customerId, setCustomerId] = useState(initialValue?.customerId ?? "");
  const [stockOptions, setStockOptions] = useState(stockItems);
  const [stockSearches, setStockSearches] = useState<Record<string, string>>({});
  const [pendingStockSearch, setPendingStockSearch] = useState<{
    key: string;
    query: string;
  } | null>(null);
  const [items, setItems] = useState<DraftItem[]>(() =>
    initialValue?.items.length
      ? initialValue.items.map(createInitialItem)
      : [createBlankItem()],
  );
  const [reservationDiscount, setReservationDiscount] = useState(
    initialValue?.reservationDiscount ?? "0.00",
  );
  const downpayment = initialValue?.downpayment ?? "0.00";

  // Modals for inline creation
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [customerModalInitialName, setCustomerModalInitialName] = useState("");

  const [stockModalTargetKey, setStockModalTargetKey] = useState<string | null>(null);
  const [stockModalInitialSearch, setStockModalInitialSearch] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          "/reservation-options/customers?q=" + encodeURIComponent(customerSearch),
          { signal: controller.signal },
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
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [customerId, customerSearch]);

  useEffect(() => {
    if (!pendingStockSearch?.query.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const exclude = initialValue ? "&exclude=" + initialValue.id : "";
        const response = await fetch(
          "/reservation-options/stock?q=" +
            encodeURIComponent(pendingStockSearch.query) +
            exclude,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = (await response.json()) as {
          options: ReservationStockOption[];
        };
        setStockOptions((current) => {
          const merged = new Map(current.map((option) => [option.id, option]));
          body.options.forEach((option) => merged.set(option.id, option));
          return [...merged.values()];
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        console.error("Error fetching stock options:", error);
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [initialValue, pendingStockSearch]);

  const stockById = useMemo(
    () => new Map(stockOptions.map((item) => [item.id, item])),
    [stockOptions],
  );
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
    items.map((item) => ({
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
    items.map((item) => ({
      reservationItemId: item.reservationItemId,
      stockItemId: item.stockItemId,
      quantity: item.quantityInput,
      sellingPrice: item.unitPrice,
      discount: item.discount,
    })),
  );

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

  function handleOpenStockModal(itemKey: string, prefill = "") {
    setStockModalTargetKey(itemKey);
    setStockModalInitialSearch(prefill);
  }

  function handleStockCreated(newStock: ReservationStockOption, targetKey: string, price?: number) {
    setStockOptions((current) => [newStock, ...current.filter((s) => s.id !== newStock.id)]);
    updateItem(targetKey, {
      stockItemId: newStock.id,
      itemName: newStock.name,
      sku: newStock.sku,
      imagePath: newStock.imagePath,
      unitPrice: price && price > 0 ? String(price) : "",
      quantity: 1,
      quantityInput: "1",
      discount: "0.00",
    });
    setStockSearches((current) => ({ ...current, [targetKey]: "" }));
    setStockModalTargetKey(null);
  }

  return (
    <>
      <form action={formAction} className="space-y-8" noValidate>
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
        <input name="downpayment" type="hidden" value={downpayment} />

        {state.message && (
          <div
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            role="alert"
          >
            {state.message}
          </div>
        )}

        <section>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
                Customer
              </p>
              <h2 className="mt-1 font-serif text-2xl text-ink">
                Reservation customer
              </h2>
            </div>
            <button
              className="text-sm font-semibold text-gold-dark hover:underline"
              onClick={() => handleOpenCustomerModal(customerSearch)}
              type="button"
            >
              + Add customer
            </button>
          </div>
          <div className="mt-5 max-w-2xl">
            <CustomerCombobox
              error={customerId ? undefined : state.fieldErrors?.customerId?.[0]}
              onAddNew={(search) => handleOpenCustomerModal(search)}
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

      <section className="border-t border-border pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
              Jewelry items
            </p>
            <h2 className="mt-1 font-serif text-2xl text-ink">
              Reserved pieces
            </h2>
          </div>
          <button
            className="rounded-xl border border-gold/40 px-4 py-2.5 text-sm font-bold text-gold-dark transition hover:bg-gold-soft"
            onClick={() => setItems((current) => [...current, createBlankItem()])}
            type="button"
          >
            + Add another item
          </button>
        </div>

        {state.fieldErrors?.items?.map((error) => (
          <p className="mt-4 text-sm font-medium text-red-700" key={error} role="alert">
            {error}
          </p>
        ))}

        <div className="mt-5 space-y-4">
          {items.map((item, index) => {
            const selectedStock = stockById.get(item.stockItemId);
            const stockSearch = stockSearches[item.key] ?? "";
            const normalizedStockSearch = stockSearch.trim().toLocaleLowerCase();
            const visibleStockOptions = stockOptions.filter(
              (stock) =>
                stock.id === item.stockItemId ||
                !normalizedStockSearch ||
                stock.name.toLocaleLowerCase().includes(normalizedStockSearch) ||
                stock.sku.toLocaleLowerCase().includes(normalizedStockSearch),
            );
            const selectedElsewhere = new Set(
              items
                .filter((candidate) => candidate.key !== item.key)
                .map((candidate) => candidate.stockItemId)
                .filter(Boolean),
            );
            const itemName = selectedStock?.name ?? item.itemName;
            const itemImagePath = selectedStock?.imagePath ?? item.imagePath;
            const stockError = item.stockItemId
              ? undefined
              : getErrors(state.fieldErrors, "items." + index + ".stockItemId");
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
                className="rounded-2xl border border-border bg-canvas/50 p-4 sm:p-5"
                key={item.key}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <StockImage
                      alt={itemName || "Jewelry item"}
                      url={getStockImageUrl(itemImagePath)}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-ink">
                        {itemName || "Select a stock item"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">Item {index + 1}</p>
                    </div>
                  </div>
                  {items.length > 1 && (
                    <button
                      className="text-xs font-bold text-red-700 hover:underline"
                      onClick={() =>
                        setItems((current) =>
                          current.filter((candidate) => candidate.key !== item.key),
                        )
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="mt-5 grid gap-4 md:grid-cols-[minmax(220px,2fr)_140px_110px_140px_150px]">
                  <div className="block text-sm font-semibold text-ink">
                    <div className="flex items-center justify-between">
                      <p>Jewelry item</p>
                      <button
                        className="text-xs font-semibold text-gold-dark hover:underline"
                        onClick={() => handleOpenStockModal(item.key, stockSearch)}
                        type="button"
                      >
                        + New product
                      </button>
                    </div>
                    <JewelryItemCombobox
                      error={Boolean(stockError)}
                      index={index}
                      onAddNew={(search) => handleOpenStockModal(item.key, search)}
                      onSearch={(value) => {
                        setStockSearches((current) => ({
                          ...current,
                          [item.key]: value,
                        }));
                        setPendingStockSearch({ key: item.key, query: value });
                      }}
                      onSelect={(selected) => {
                        updateItem(item.key, {
                          reservationItemId:
                            selected.id === item.stockItemId
                              ? item.reservationItemId
                              : undefined,
                          stockItemId: selected.id,
                          quantity: 1,
                          quantityInput: "1",
                          discount: "0.00",
                          unitPrice:
                            selected.id === item.stockItemId
                              ? item.unitPrice
                              : "",
                          itemName: selected.name,
                          sku: selected.sku,
                          imagePath: selected.imagePath,
                        });
                      }}
                      options={visibleStockOptions.filter(
                        (stock) =>
                          stock.id === item.stockItemId ||
                          !selectedElsewhere.has(stock.id),
                      )}
                      search={stockSearch}
                      selected={selectedStock}
                    />
                    <select
                      aria-hidden="true"
                      aria-invalid={Boolean(stockError)}
                      className="hidden"
                      tabIndex={-1}
                      onChange={(event) => {
                        const selected = stockById.get(event.target.value);
                        updateItem(item.key, {
                          reservationItemId: undefined,
                          stockItemId: event.target.value,
                          quantity: 1,
                          quantityInput: "1",
                          discount: "0.00",
                          unitPrice: "",
                          itemName: selected?.name ?? "",
                          sku: selected?.sku ?? "",
                          imagePath: selected?.imagePath ?? null,
                        });
                      }}
                      value={item.stockItemId}
                    >
                      <option value="">Choose active stock</option>
                      {!selectedStock && item.stockItemId && (
                        <option value={item.stockItemId}>
                          Previously selected item — choose a replacement
                        </option>
                      )}
                      {visibleStockOptions.map((stock) => (
                        <option
                          disabled={selectedElsewhere.has(stock.id)}
                          key={stock.id}
                          value={stock.id}
                        >
                          {stock.name}
                        </option>
                      ))}
                    </select>
                    {stockError?.map((error) => (
                      <span className="mt-1.5 block text-xs text-red-700" key={error}>
                        {error}
                      </span>
                    ))}
                  </div>

                  <label className="block text-sm font-semibold text-ink">
                    Selling price
                    <input
                      aria-invalid={Boolean(sellingPriceError)}
                      className="mt-2 block h-12 w-full rounded-xl border border-border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
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
                    Quantity
                    <input
                      aria-invalid={Boolean(quantityError)}
                      className={
                        "mt-2 block h-12 w-full rounded-xl border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 " +
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
                    Discount <span className="font-normal text-muted">(optional)</span>
                    <input
                      aria-invalid={Boolean(discountError)}
                      className={
                        "mt-2 block h-12 w-full rounded-xl border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 " +
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

                  <div>
                    <p className="text-sm font-semibold text-ink">Line total</p>
                    <div className="mt-2 flex h-12 items-center rounded-xl border border-border bg-white px-3 text-sm font-bold text-ink">
                      {formatCurrency(preview.lines[index]?.lineTotalCents / 100 || 0)}
                    </div>
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-7 border-t border-border pt-8 lg:grid-cols-[1fr_340px]">
        <TextareaField
          defaultValue={initialValue?.notes ?? ""}
          errors={state.fieldErrors?.notes}
          label="Reservation notes"
          maxLength={4000}
          name="notes"
          placeholder="Sizing, pickup arrangements, or other reservation details"
          rows={7}
        />

        <div className="rounded-2xl border border-border bg-canvas p-5">
          <h2 className="font-serif text-2xl text-ink">Reservation summary</h2>
          <dl className="mt-5 space-y-3 border-b border-border pb-5 text-sm">
            <SummaryTextRow
              label="Customer name"
              value={selectedCustomer?.name ?? "Select a customer"}
            />
            {selectedCustomer?.facebookName && (
              <SummaryTextRow
                label="Facebook / CS"
                value={selectedCustomer.facebookName}
              />
            )}
            <SummaryTextRow
              label="Reservation number"
              value={initialValue?.reservationNo ?? "Assigned when saved"}
            />
            <SummaryTextRow label="Status" value="Reserved" />
            <SummaryTextRow
              label="Quantity"
              value={String(items.filter((item) => item.stockItemId).length)}
            />
          </dl>
          <div className="mt-5 grid gap-4">
            <InputField
              errors={state.fieldErrors?.reservationDiscount}
              inputMode="decimal"
              label="Reservation discount"
              min="0"
              name="reservationDiscount"
              onChange={(event) => setReservationDiscount(event.target.value)}
              step="0.01"
              type="number"
              value={reservationDiscount}
            />
          </div>
          <dl className="mt-6 space-y-3 border-t border-border pt-5 text-sm">
            <SummaryRow label="Subtotal" value={preview.subtotalCents} />
            <SummaryRow
              label="Reservation discount"
              value={parseMoneyToCents(reservationDiscount) ?? 0}
            />
            <SummaryRow label="Total" strong value={preview.totalCents} />
            {(parseMoneyToCents(downpayment) ?? 0) > 0 && (
              <SummaryRow
                label="Previously recorded amount"
                value={parseMoneyToCents(downpayment) ?? 0}
              />
            )}
            <SummaryRow label="Balance" strong value={preview.balanceCents} />
          </dl>
          <p className="mt-4 text-xs leading-5 text-muted">
            Preview only. Prices, availability, and every total are verified again
            by the server when saved.
          </p>
        </div>
      </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
          <FormSubmitButton>
            {initialValue ? "Save reservation" : "Create reservation"}
          </FormSubmitButton>
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-border px-5 text-sm font-semibold text-ink hover:border-gold"
            href={initialValue ? "/reservations/" + initialValue.id : "/reservations"}
          >
            Cancel
          </Link>
        </div>
      </form>

      {isCustomerModalOpen && (
        <InlineCustomerModal
          initialName={customerModalInitialName}
          onClose={() => setIsCustomerModalOpen(false)}
          onSuccess={handleCustomerCreated}
        />
      )}

      {stockModalTargetKey && (
        <InlineStockModal
          initialSearch={stockModalInitialSearch}
          onClose={() => setStockModalTargetKey(null)}
          onSuccess={(stock, price) =>
            handleStockCreated(stock, stockModalTargetKey, price)
          }
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

function InlineStockModal({
  initialSearch,
  onClose,
  onSuccess,
}: {
  initialSearch: string;
  onClose: () => void;
  onSuccess: (stock: ReservationStockOption, price?: number) => void;
}) {
  const [sku, setSku] = useState(initialSearch.toUpperCase());
  const [name, setName] = useState(initialSearch);
  const [category, setCategory] = useState<StockCategory>("Ring");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});

    try {
      const numericPrice = price ? Number(price) : undefined;
      const numericQuantity = quantity ? Number(quantity) : 1;
      const result = await createStockItemInline({
        sku: sku.trim().toUpperCase(),
        name: name.trim(),
        category,
        description: description.trim() || undefined,
        price: numericPrice,
        quantity: numericQuantity,
      });

      if (!result.success) {
        setError(result.message);
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        return;
      }

      onSuccess(
        {
          id: result.item.id,
          sku: result.item.sku,
          name: result.item.name,
          imagePath: result.item.imagePath,
        },
        numericPrice,
      );
    } catch (err) {
      console.error(err);
      setError("An unexpected error occurred while creating the stock item.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <h3 className="font-serif text-xl font-bold text-ink">Add New Jewelry Product</h3>
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
          <div className="grid grid-cols-2 gap-4">
            <InputField
              autoFocus
              errors={fieldErrors.sku}
              label="Item Code / SKU *"
              name="sku"
              onChange={(e) => setSku(e.target.value.toUpperCase())}
              placeholder="e.g. R001"
              required
              value={sku}
            />

            <SelectField
              errors={fieldErrors.category}
              label="Category *"
              name="category"
              onChange={(e) => setCategory(e.target.value as StockCategory)}
              required
              value={category}
            >
              {STOCK_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </SelectField>
          </div>

          <InputField
            errors={fieldErrors.name}
            label="Product Name *"
            name="name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 18K Gold Solitaire Ring"
            required
            value={name}
          />

          <div className="grid grid-cols-2 gap-4">
            <InputField
              errors={fieldErrors.price}
              inputMode="decimal"
              label="Selling Price"
              min="0"
              name="price"
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              step="0.01"
              type="number"
              value={price}
            />

            <InputField
              errors={fieldErrors.quantity}
              inputMode="numeric"
              label="Quantity"
              min="1"
              name="quantity"
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="1"
              step="1"
              type="number"
              value={quantity}
            />
          </div>

          <TextareaField
            errors={fieldErrors.description}
            label="Description (optional)"
            name="description"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Material, carat, sizing, or other details"
            rows={2}
            value={description}
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
              {loading ? "Saving..." : "Save & Add to Reservation"}
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
      <p className="text-sm font-semibold text-ink">Customer</p>
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

function JewelryItemCombobox({
  index,
  search,
  selected,
  options,
  error,
  onSearch,
  onSelect,
  onAddNew,
}: {
  index: number;
  search: string;
  selected?: ReservationStockOption;
  options: ReservationStockOption[];
  error: boolean;
  onSearch: (value: string) => void;
  onSelect: (option: ReservationStockOption) => void;
  onAddNew?: (search: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  function select(option: ReservationStockOption) {
    onSelect(option);
    onSearch("");
    setOpen(false);
  }

  return (
    <div
      className={"relative " + (open ? "z-[70]" : "z-20")}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      ref={rootRef}
    >
      <input
        aria-activedescendant={
          open && options[activeIndex]
            ? "stock-option-" + index + "-" + options[activeIndex].id
            : undefined
        }
        aria-controls={"stock-options-" + index}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={"Search jewelry item " + (index + 1)}
        autoComplete="off"
        className={
          "mt-2 block h-12 w-full rounded-xl border bg-white px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 " +
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
          } else if (
            event.key === "Enter" &&
            open &&
            options[activeIndex]
          ) {
            event.preventDefault();
            select(options[activeIndex]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Search jewelry item..."
        role="combobox"
        type="search"
        value={search}
      />
      {open && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-white p-1 shadow-xl"
          id={"stock-options-" + index}
          role="listbox"
        >
          {onAddNew && search.trim() && (
            <button
              className="flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left font-semibold text-gold-dark hover:bg-gold-soft"
              onClick={() => {
                setOpen(false);
                onAddNew(search.trim());
              }}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <span className="text-base leading-none">+</span>
              <span className="text-xs">Create product &quot;{search.trim()}&quot;</span>
            </button>
          )}
          {options.length ? (
            options.map((option, optionIndex) => (
              <button
                aria-selected={option.id === selected?.id}
                className={
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-canvas " +
                  (optionIndex === activeIndex ? "bg-canvas" : "")
                }
                id={"stock-option-" + index + "-" + option.id}
                key={option.id}
                onClick={() => select(option)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(optionIndex)}
                role="option"
                type="button"
              >
                <StockImage
                  alt={option.name}
                  url={getStockImageUrl(option.imagePath)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {option.name}
                  </span>
                  <span className="block text-[11px] font-normal text-muted">
                    Code: {option.sku}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-4 text-center">
              <p className="text-xs font-normal text-muted">No matching jewelry items.</p>
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
                  + Create product &quot;{search.trim() || "New Item"}&quot; now
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryTextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="max-w-[190px] text-right font-semibold text-ink">{value}</dd>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className={strong ? "font-bold text-ink" : "text-muted"}>{label}</dt>
      <dd className={strong ? "font-bold text-ink" : "font-semibold text-ink"}>
        {formatCurrency(value / 100)}
      </dd>
    </div>
  );
}

