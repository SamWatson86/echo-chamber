import clsx from 'clsx';

type Props = {
  label: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'error';
};

export function StatusPill({ label, tone = 'neutral' }: Props) {
  return (
    <span
      className={clsx(
        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide',
        tone === 'ok' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
        tone === 'warn' && 'border-amber-500/40 bg-amber-500/10 text-amber-300',
        tone === 'error' && 'border-rose-500/40 bg-rose-500/10 text-rose-300',
        tone === 'neutral' && 'border-slate-700 bg-slate-800 text-slate-300',
      )}
    >
      {label}
    </span>
  );
}
