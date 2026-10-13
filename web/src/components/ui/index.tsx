import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X, AlertCircle } from 'lucide-react';
import { initials } from '../../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Button ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-ink-soft disabled:bg-stone-light',
  secondary: 'bg-white text-ink border border-line-strong hover:border-ink/40 hover:bg-mist/60',
  ghost: 'text-ink-soft hover:bg-mist',
  quiet: 'text-plum hover:bg-plum-tint',
  danger: 'bg-rose text-white hover:bg-rose/90',
};
export function Button({
  variant = 'secondary', size = 'md', loading, icon, children, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
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
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>{children}</span>;
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
      <p className="h-display text-2xl">{title}</p>
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
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
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

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cx('inline-flex rounded-lg bg-mist p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors', value === o.value ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
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
    <div className={cx('fixed inset-0 z-50 flex bg-ink/30 backdrop-blur-[2px]', side ? 'justify-end' : 'items-end justify-center sm:items-center sm:p-6')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
          <h2 className="h-display text-[22px] leading-tight">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-stone hover:bg-mist hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
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
      {open && (
        <div className={cx('absolute z-40 mt-1 min-w-[200px] rounded-xl border border-line bg-white py-1 shadow-pop animate-rise', align === 'right' ? 'right-0' : 'left-0')} role="menu">
          {items.filter((i) => !i.hidden).map((i, idx) => (
            <button
              key={idx}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-mist', i.danger ? 'text-rose' : 'text-ink')}
            >
              {i.icon && <span className="text-stone">{i.icon}</span>}
              {i.label}
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
    <div className={cx('mb-3 flex items-end justify-between gap-3', className)}>
      <h2 className="h-display text-[22px] leading-none">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="h-display text-[34px] leading-[1.05] sm:text-[40px]">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[15px] text-stone">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
