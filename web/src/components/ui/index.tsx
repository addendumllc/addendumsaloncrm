import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X, AlertCircle } from 'lucide-react';
import { initials } from '../../lib/format';
import { Tc, tc, titleCase } from '../../lib/titleCase';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Button ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
const VARIANTS: Record<Variant, string> = {
  // The person's accent (their own User Color, or the salon's): every button follows it.
  primary: 'bg-plum text-white hover:bg-plum-dark disabled:bg-stone-light',
  secondary: 'bg-white text-plum border border-plum/30 hover:border-plum/60 hover:bg-plum-tint',
  ghost: 'text-plum hover:bg-plum-tint',
  quiet: 'text-plum hover:bg-plum-tint',
  danger: 'bg-rose text-white hover:bg-rose/90',
};
export function Button({
  variant = 'secondary', size = 'md', loading, icon, children, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'icon'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-button,0px)] font-button font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        // Taller on phones so they're easy to tap; compact on larger screens. "Button size" (Display) adjusts btn-sm/btn-md.
        // One sizing system everywhere (both businesses): the theme changes colours, fonts and corners, never these.
        size === 'sm' ? 'btn-sm h-9 px-3 text-[13px] sm:h-8 sm:px-2.5' : size === 'icon' ? 'btn-md h-11 w-11 sm:h-10 sm:w-10' : 'btn-md h-11 px-4 text-[15px] sm:h-10 sm:px-3.5 sm:text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {tc(children)}
    </button>
  );
}

// ---------- Badge ----------
type Tone = 'neutral' | 'plum' | 'sage' | 'rose' | 'amber' | 'ink';
const TONES: Record<Tone, string> = {
  neutral: 'bg-mist text-ink-soft',
  plum: 'bg-plum-tint text-plum',
  sage: 'bg-sage-tint text-sage',
  rose: 'bg-rose-tint text-rose',
  amber: 'bg-amber-tint text-amber',
  ink: 'bg-ink text-white',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx(`badge badge-${tone} inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium`, TONES[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-stone', className)} />;
}

export function PageLoading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-rose/20 bg-rose-tint px-4 py-3 text-sm text-rose">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">{(error as Error)?.message ?? 'Unable to load this right now.'}</div>
      {onRetry && <button className="font-medium underline" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-stone-light">{icon}</div>}
      <p className="h-display text-2xl"><Tc>{title}</Tc></p>
      {children && <p className="mt-1 max-w-sm text-sm text-stone">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Avatar({ name, color, size = 'md' }: { name: string; color?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'sm' ? 'h-7 w-7 text-[11px]' : size === 'lg' ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-xs';
  return (
    <span
      aria-hidden
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', s, !color && 'bg-mist text-ink-soft')}
      style={color ? { backgroundColor: `${color}22`, color } : undefined}
    >
      {initials(name)}
    </span>
  );
}

// ---------- Form fields ----------
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{titleCase(label)}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-ink">{titleCase(label)}</p>
        {description && <p className="mt-0.5 text-[13px] text-stone">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-plum' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, size }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string; size?: 'sm' }) {
  return (
    // Never wider than the screen: on a phone, a long row of choices scrolls sideways instead of running off the edge.
    <div className={cx('inline-flex max-w-full overflow-x-auto scrollbar-none rounded-lg bg-mist p-0.5 font-button', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('whitespace-nowrap rounded-md font-medium transition-colors', size === 'sm' ? 'px-2.5 py-1 text-[12.5px]' : 'px-3 py-1.5 text-[13px]', value === o.value ? 'bg-white text-plum shadow-sm' : 'text-stone hover:text-plum')}
        >
          {tc(o.label)}
        </button>
      ))}
    </div>
  );
}

/**
 * A page's sections as underlined tabs on one line, with `aside` (e.g. the Addendum Salon / Addendum Hair switch) at
 * its right — one bar across the top instead of stacked toggles.
 */
export function PageTabs<T extends string>({ value, onChange, options, aside, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; aside?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-5 flex flex-wrap-reverse items-end justify-between gap-x-4 gap-y-2 sm:border-b sm:border-line', className)}>
      {/* Phones: the pages as a dropdown, so the current one always shows. */}
      {options.length > 1 && (
        <select className="field h-11 w-full text-[16px] font-medium sm:hidden" value={value} onChange={(e) => onChange(e.target.value as T)} aria-label="Page">
          {options.map((o) => <option key={o.value} value={o.value}>{typeof o.label === 'string' ? tc(o.label) : o.value}</option>)}
        </select>
      )}
      <div className={cx('-mb-px max-w-full gap-5 overflow-x-auto scrollbar-none font-button', options.length > 1 ? 'hidden sm:flex' : 'flex border-b border-line sm:border-0')} role="tablist">
        {options.map((o) => (
          <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
            className={cx('whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[14px] font-medium transition-colors focus:outline-none focus-visible:text-plum', value === o.value ? 'border-plum text-ink' : 'border-transparent text-stone hover:text-ink')}>
            {tc(o.label)}
          </button>
        ))}
      </div>
      {aside && <div className="ml-auto pb-2">{aside}</div>}
    </div>
  );
}

// ---------- Modal / drawer ----------
export function Modal({ open, onClose, title, children, footer, wide, side }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; side?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,select,button[data-autofocus]')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className={cx('fixed inset-0 z-50 flex bg-black/35 backdrop-blur-[2px]', side ? 'justify-end' : 'items-end justify-center sm:items-center sm:p-6')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={cx(
          'flex max-h-[100dvh] w-full flex-col bg-white shadow-pop',
          side ? 'h-full max-w-xl animate-slide-in' : cx('rounded-t-2xl sm:rounded-2xl sm:max-h-[90vh] animate-rise', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'),
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <h2 className="h-display text-[22px] leading-tight"><Tc>{title}</Tc></h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-stone hover:bg-mist hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="app-content flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Dropdown menu ----------
export function Menu({ trigger, items, align = 'right' }: { trigger: (open: () => void) => ReactNode; items: { label: ReactNode; onClick: () => void; icon?: ReactNode; danger?: boolean; hidden?: boolean }[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className="fixed inset-0 z-[55] bg-ink/30 sm:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && (
        // Phones: a sheet along the bottom of the screen (bigger tap targets, never off the edge); elsewhere a dropdown.
        <div className={cx('absolute z-40 mt-1 min-w-[200px] rounded-xl border border-line bg-white py-1 shadow-pop animate-rise max-sm:max-h-[70vh] max-sm:overflow-y-auto max-sm:py-2', align === 'right' ? 'right-0' : 'left-0', 'max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] max-sm:top-auto max-sm:left-2 max-sm:right-2 max-sm:mt-0 max-sm:mb-0 max-sm:w-auto max-sm:z-[60]')} role="menu">
          {items.filter((i) => !i.hidden).map((i, idx) => (
            <button
              key={idx}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-mist max-sm:py-3 max-sm:text-[15px]', i.danger ? 'text-rose' : 'text-ink')}
            >
              {i.icon && <span className="text-stone">{i.icon}</span>}
              {tc(i.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Toasts ----------
interface Toast { id: number; message: string; tone: 'success' | 'error' | 'info' }
const ToastCtx = createContext<(message: string, tone?: Toast['tone']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-4 py-2.5 text-sm shadow-pop animate-rise', t.tone === 'error' ? 'bg-rose text-white' : 'bg-ink text-white')}>
            {t.tone === 'success' && <Check className="h-4 w-4 text-plum-soft" />}
            {t.tone === 'error' && <AlertCircle className="h-4 w-4" />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-3 flex min-h-9 flex-wrap items-end justify-between gap-x-3 gap-y-2', className)}>
      <h2 className="h-display min-w-0 text-[22px] leading-tight"><Tc>{children}</Tc></h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="h-display text-[34px] leading-[1.05] sm:text-[40px]"><Tc>{title}</Tc></h1>
        {subtitle && <p className="mt-1.5 text-[15px] text-stone">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </div>
  );
}
