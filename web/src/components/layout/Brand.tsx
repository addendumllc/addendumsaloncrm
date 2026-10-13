import { DEFAULT_APPEARANCE, logoUrl, type Appearance } from '@addendum/shared';
import { useSettings } from '../../api/hooks';
import { cx } from '../ui';

/** The salon's look from Settings → Appearance (defaults until settings load). */
export function useAppearance(): Appearance {
  const { data } = useSettings();
  return { ...DEFAULT_APPEARANCE, ...(data?.settings.appearance ?? {}) };
}

const SIZES = {
  sidebar: { img: 'max-h-12 max-w-[180px]', name: 'text-[26px]', gap: 'mt-2' },
  header: { img: 'max-h-7 max-w-[140px]', name: 'text-[22px]', gap: 'ml-2' },
  login: { img: 'max-h-20 max-w-[260px]', name: 'text-[44px]', gap: 'mt-3' },
};

/** Logo and/or salon name, as chosen in Settings → Appearance. Falls back to the name when there's no logo. */
export function BrandMark({ a, size, className }: { a: Appearance; size: keyof typeof SIZES; className?: string }) {
  const src = logoUrl(a);
  const z = SIZES[size];
  const showLogo = !!src && a.logoMode !== 'name';
  const showName = !showLogo || a.logoMode === 'logo_name';
  const name = <p className={cx('font-display font-semibold leading-none tracking-[0.02em] text-ink', z.name, showLogo && z.gap)}>{a.brandName}</p>;
  return (
    <div className={cx(size === 'header' ? 'flex items-center' : 'flex flex-col', size === 'login' && 'items-center text-center', className)}>
      {showLogo && <img src={src!} alt={a.brandName} className={cx('w-auto object-contain', z.img)} />}
      {showName && name}
    </div>
  );
}
