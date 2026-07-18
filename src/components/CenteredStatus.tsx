export function CenteredStatus({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={compact ? "status compact" : "status"}><span className="spinner" />{label}</div>;
}
