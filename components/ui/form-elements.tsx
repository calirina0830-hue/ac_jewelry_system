"use client";

import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useFormStatus } from "react-dom";

const controlClass =
  "mt-2 block w-full rounded-xl border border-border bg-white px-4 text-[15px] font-normal text-ink outline-none transition placeholder:text-muted/55 focus:border-gold focus:ring-4 focus:ring-gold/10";

function Errors({ id, errors }: { id: string; errors?: string[] }) {
  return errors?.map((message) => (
    <span className="mt-1.5 block text-xs font-normal text-red-700" id={id} key={message}>
      {message}
    </span>
  ));
}

export function InputField({
  label,
  name,
  errors,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  errors?: string[];
}) {
  const errorId = name + "-error";

  return (
    <label className="block text-sm font-semibold text-ink" htmlFor={name}>
      {label}
      <input
        {...props}
        aria-describedby={errors?.length ? errorId : undefined}
        aria-invalid={Boolean(errors?.length)}
        className={controlClass + " h-12 " + (errors?.length ? "border-red-400" : "")}
        id={name}
        name={name}
      />
      <Errors errors={errors} id={errorId} />
    </label>
  );
}

export function TextareaField({
  label,
  name,
  errors,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  name: string;
  errors?: string[];
}) {
  const errorId = name + "-error";

  return (
    <label className="block text-sm font-semibold text-ink" htmlFor={name}>
      {label}
      <textarea
        {...props}
        aria-describedby={errors?.length ? errorId : undefined}
        aria-invalid={Boolean(errors?.length)}
        className={controlClass + " min-h-28 py-3 " + (errors?.length ? "border-red-400" : "")}
        id={name}
        name={name}
      />
      <Errors errors={errors} id={errorId} />
    </label>
  );
}

export function SelectField({
  label,
  name,
  errors,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  name: string;
  errors?: string[];
}) {
  const errorId = name + "-error";

  return (
    <label className="block text-sm font-semibold text-ink" htmlFor={name}>
      {label}
      <select
        {...props}
        aria-describedby={errors?.length ? errorId : undefined}
        aria-invalid={Boolean(errors?.length)}
        className={controlClass + " h-12 " + (errors?.length ? "border-red-400" : "")}
        id={name}
        name={name}
      >
        {children}
      </select>
      <Errors errors={errors} id={errorId} />
    </label>
  );
}

export function FormSubmitButton({ children }: { children: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      className="inline-flex h-11 items-center justify-center rounded-xl bg-gold px-6 text-sm font-bold text-white transition hover:bg-gold-dark disabled:cursor-wait disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      {pending ? "Saving…" : children}
    </button>
  );
}
