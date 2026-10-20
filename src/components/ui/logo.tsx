import logo from "../../../public/brand/logo.png";
import logoWhite from "../../../public/brand/logo-white.png";

/**
 * The Ammar Academy logo. "onDark" uses the white version for navy backgrounds.
 * Height sets the size; width follows the logo's proportions.
 *
 * A plain <img> on purpose: some copies sit in containers hidden at certain screen widths
 * (the sidebar on phones, the phone header on desktop). An eager image would be preloaded and
 * then go unused there; a small lazy image near the top still loads immediately when shown.
 */
export function Logo({ height = 32, onDark = false, className }: { height?: number; onDark?: boolean; className?: string }) {
  const src = onDark ? logoWhite : logo;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src.src}
      alt="Ammar Academy"
      height={height}
      width={Math.round((src.width / src.height) * height)}
      loading="lazy"
      decoding="async"
      className={className}
      style={{ height, width: "auto" }}
    />
  );
}

/** Logo plus a small "CRM" label. */
export function LogoWithLabel({ height = 32, onDark = false }: { height?: number; onDark?: boolean }) {
  return (
    <span className="flex items-end gap-2">
      <Logo height={height} onDark={onDark} />
      <span className={onDark ? "pb-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-400" : "pb-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-600"}>CRM</span>
    </span>
  );
}
