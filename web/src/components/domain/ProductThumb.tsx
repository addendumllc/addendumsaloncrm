import { useState } from 'react';
import { Package } from 'lucide-react';
import { cx } from '../ui';

/** A product's photo from its listing (Square or Shopify), small and lazy-loaded; a quiet placeholder when there isn't one. */
export function ProductThumb({ src, alt, size = 'md', className }: { src: string | null | undefined; alt: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-14 w-14' : 'h-11 w-11';
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-mist', box, className)}>
      {src && !failed
        ? <img src={src} alt={alt} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : <Package className="h-4 w-4 text-stone-light" aria-hidden />}
    </span>
  );
}
