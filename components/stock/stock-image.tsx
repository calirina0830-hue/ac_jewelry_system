"use client";

import Image from "next/image";
import { useState } from "react";

export function StockImage({
  url,
  alt,
  size = "small",
}: {
  url: string | null;
  alt: string;
  size?: "small" | "large";
}) {
  const sizeClass = size === "large" ? "aspect-square w-full" : "size-12";
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!url || failedUrl === url) {
    return (
      <div
        aria-label={alt + " image unavailable"}
        className={
          "grid shrink-0 place-items-center rounded-xl border border-border bg-gold-soft font-serif text-gold-dark " +
          sizeClass
        }
        role="img"
      >
        ◇
      </div>
    );
  }

  return (
    <div
      className={
        "relative shrink-0 overflow-hidden rounded-xl border border-border bg-white " +
        sizeClass
      }
    >
      <Image
        alt={alt}
        className="object-cover"
        fill
        onError={() => setFailedUrl(url)}
        sizes={size === "large" ? "(max-width: 1024px) 100vw, 600px" : "48px"}
        src={url}
        unoptimized
      />
    </div>
  );
}
