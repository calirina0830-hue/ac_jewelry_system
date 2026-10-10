import { BUSINESS } from "@/lib/constants/business";

type BrandMarkProps = {
  compact?: boolean;
  light?: boolean;
};

export function BrandMark({ compact = false, light = false }: BrandMarkProps) {
  return (
    <div className="flex items-center gap-3" aria-label={BUSINESS.name}>
      <span
        className={
          "grid size-10 rotate-45 place-items-center rounded-[10px] border " +
          (light
            ? "border-white/30 bg-white/10"
            : "border-gold/35 bg-gold-soft")
        }
        aria-hidden="true"
      >
        <span
          className={
            "size-3 rounded-sm border " +
            (light ? "border-gold-light bg-gold-light/20" : "border-gold bg-white")
          }
        />
      </span>
      {!compact && (
        <span className="leading-none">
          <span
            className={
              "block font-serif text-[1.35rem] tracking-[0.08em] " +
              (light ? "text-white" : "text-ink")
            }
          >
            {BUSINESS.shortName}
          </span>
          <span
            className={
              "mt-1 block whitespace-nowrap text-[0.52rem] font-semibold tracking-[0.12em] " +
              (light ? "text-gold-light" : "text-gold-dark")
            }
          >
            {BUSINESS.descriptor.toUpperCase()}
          </span>
        </span>
      )}
    </div>
  );
}
