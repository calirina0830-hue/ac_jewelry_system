"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";

import { createStockItem, updateStockItem } from "@/actions/stock";
import {
  FormSubmitButton,
  InputField,
  SelectField,
  TextareaField,
} from "@/components/ui/form-elements";
import {
  MAX_STOCK_IMAGE_BYTES,
  STOCK_CATEGORIES,
  STOCK_IMAGE_MIME_TYPES,
} from "@/lib/constants/stock";
import type { Database } from "@/types/database";
import { INITIAL_FORM_STATE } from "@/types/forms";

type StockItem = Database["public"]["Tables"]["stock_items"]["Row"];

export function StockForm({
  item,
  imageUrl,
}: {
  item?: StockItem;
  imageUrl?: string | null;
}) {
  const action = item ? updateStockItem : createStockItem;
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [previewUrl, setPreviewUrl] = useState(imageUrl ?? null);
  const [removeImage, setRemoveImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  return (
    <form action={formAction} className="space-y-7" noValidate>
      {item && (
        <>
          <input name="id" type="hidden" value={item.id} />
          <input name="updatedAt" type="hidden" value={item.updated_at} />
        </>
      )}
      <input
        name="removeImage"
        type="hidden"
        value={removeImage ? "true" : "false"}
      />
      {state.message && (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          {state.message}
        </div>
      )}

      <div className="grid gap-7 lg:grid-cols-[220px_1fr]">
        <div>
          <p className="text-sm font-semibold text-ink">Item image</p>
          <div
            aria-label={previewUrl ? "Selected stock image preview" : "No stock image selected"}
            className="mt-2 grid aspect-square w-full place-items-center rounded-2xl border border-dashed border-border bg-gold-soft bg-cover bg-center font-serif text-4xl text-gold-dark"
            role="img"
            style={
              previewUrl
                ? { backgroundImage: "url(" + JSON.stringify(previewUrl) + ")" }
                : undefined
            }
          >
            {!previewUrl && "◇"}
          </div>
          <label className="mt-3 block">
            <span className="sr-only">Choose stock image</span>
            <input
              accept={STOCK_IMAGE_MIME_TYPES.join(",")}
              className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-2 file:text-xs file:font-bold file:text-white"
              name="image"
              ref={imageInputRef}
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (previewUrl?.startsWith("blob:")) {
                  URL.revokeObjectURL(previewUrl);
                }

                if (file) {
                  setPreviewUrl(URL.createObjectURL(file));
                  setRemoveImage(false);
                }
              }}
              type="file"
            />
          </label>
          <p className="mt-2 text-xs leading-5 text-muted">
            JPEG, PNG, or WebP. Maximum{" "}
            {MAX_STOCK_IMAGE_BYTES / 1024 / 1024} MB.
          </p>
          {state.fieldErrors?.image?.map((error) => (
            <p className="mt-2 text-xs text-red-700" key={error}>
              {error}
            </p>
          ))}
          {previewUrl && (
            <button
              className="mt-3 text-xs font-bold text-red-700 hover:underline"
              onClick={() => {
                if (previewUrl.startsWith("blob:")) {
                  URL.revokeObjectURL(previewUrl);
                }

                setPreviewUrl(null);
                setRemoveImage(true);
                if (imageInputRef.current) {
                  imageInputRef.current.value = "";
                }
              }}
              type="button"
            >
              Remove image
            </button>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <InputField
            autoCapitalize="characters"
            defaultValue={item?.sku}
            errors={state.fieldErrors?.sku}
            label="SKU"
            maxLength={64}
            name="sku"
            placeholder="RNG-001"
            required
          />
          <InputField
            defaultValue={item?.name}
            errors={state.fieldErrors?.name}
            label="Item name"
            maxLength={160}
            name="name"
            placeholder="18K Gold Solitaire Ring"
            required
          />
          <SelectField
            defaultValue={item?.category ?? STOCK_CATEGORIES[0]}
            errors={state.fieldErrors?.category}
            label="Category"
            name="category"
            required
          >
            {STOCK_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </SelectField>
          <div className="sm:col-span-2">
            <TextareaField
              defaultValue={item?.description ?? ""}
              errors={state.fieldErrors?.description}
              label="Description"
              maxLength={4000}
              name="description"
              placeholder="Materials, stones, dimensions, and distinguishing details"
              rows={6}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <FormSubmitButton>
          {item ? "Save changes" : "Add stock item"}
        </FormSubmitButton>
        <Link
          className="inline-flex h-11 items-center rounded-xl border border-border px-5 text-sm font-semibold text-ink hover:border-gold"
          href={item ? "/stock/" + item.id : "/stock"}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
