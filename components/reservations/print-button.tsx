"use client";

export function PrintButton({ className, label = "Print / Save PDF" }: { className?: string; label?: string }) {
  return (
    <button className={className} onClick={() => window.print()} type="button">
      {label}
    </button>
  );
}
