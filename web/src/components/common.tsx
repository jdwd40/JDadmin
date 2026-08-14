import { ReactNode } from 'react';
import { canNext, canPrev, pageWindowLabel } from '../lib/pagination';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="error-box">{msg}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pager">
      <button disabled={!canPrev(page)} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <span className="muted">{pageWindowLabel(page, pageSize, total)}</span>
      <button disabled={!canNext(page, total, pageSize)} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  );
}

export function CapabilityNote({ supported, label }: { supported: boolean; label: string }) {
  if (supported) return null;
  return (
    <div className="warn-box">
      {label} is not supported by this application’s adapter. The control is disabled rather than
      faked.
    </div>
  );
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}
