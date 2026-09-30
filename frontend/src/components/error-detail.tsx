import { useState } from 'react';
import { describeError, type ErrorContext } from '@/lib/describe-error';

// Clear French cause + advice for a stored raw error, the raw text itself kept one click away for
// debugging (spec: "repliable" — never the main line, never hidden entirely).
export function ErrorDetail({ raw, context }: { raw: string; context: ErrorContext }) {
  const [open, setOpen] = useState(false);
  const { message, hint } = describeError(raw, context);
  return (
    <div className="mt-0.5 text-xs text-muted-foreground">
      <p>
        {message}
        {hint && ` ${hint}`}
      </p>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-0.5 underline underline-offset-2 hover:text-foreground"
      >
        {open ? 'Masquer les détails techniques' : 'Détails techniques'}
      </button>
      {open && <pre className="mt-1 rounded bg-muted px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-all">{raw}</pre>}
    </div>
  );
}
