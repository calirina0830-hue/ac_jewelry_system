"use client";

import type { InputHTMLAttributes } from "react";
import { useFormStatus } from "react-dom";

import type { AuthActionState } from "@/types/auth";

type FormFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  error?: string[];
};

export function FormField({
  label,
  name,
  error,
  className,
  ...props
}: FormFieldProps) {
  const errorId = error?.length ? name + "-error" : undefined;

  return (
    <label className="block text-sm font-semibold text-ink" htmlFor={name}>
      {label}
      <input
        {...props}
        id={name}
        name={name}
        aria-describedby={errorId}
        aria-invalid={Boolean(error)}
        className={
          "mt-2 block h-12 w-full rounded-xl border bg-white px-4 text-[15px] font-normal text-ink outline-none transition placeholder:text-muted/55 focus:border-gold focus:ring-4 focus:ring-gold/10 " +
          (error ? "border-red-400" : "border-border") +
          " " +
          (className ?? "")
        }
      />
      {error?.map((message) => (
        <span
          className="mt-1.5 block text-xs font-normal text-red-700"
          id={errorId}
          key={message}
        >
          {message}
        </span>
      ))}
    </label>
  );
}

export function SubmitButton({ children }: { children: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      className="flex h-12 w-full items-center justify-center rounded-xl bg-gold px-5 text-sm font-bold text-white shadow-[0_10px_30px_rgba(139,100,46,0.18)] transition hover:bg-gold-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-wait disabled:opacity-65"
      disabled={pending}
      type="submit"
    >
      {pending ? "Please wait…" : children}
    </button>
  );
}

export function ActionMessage({ state }: { state: AuthActionState }) {
  if (!state.message) {
    return null;
  }

  return (
    <div
      className={
        "rounded-xl border px-4 py-3 text-sm leading-6 " +
        (state.status === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-red-200 bg-red-50 text-red-800")
      }
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </div>
  );
}
