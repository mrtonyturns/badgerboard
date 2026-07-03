// LoadingBar.jsx — thin animated progress bar shown during data fetches.
// Always mounted: unmounting used to change sibling order inside `space-y-*`
// containers, shifting entire pages by 24px when a fetch finished (misclicks).
export default function LoadingBar({ loading }) {
  return (
    <div
      aria-hidden={!loading}
      className="fixed top-0 left-0 right-0 z-[9999] h-0.5 overflow-hidden pointer-events-none"
      style={{ opacity: loading ? 1 : 0, transition: 'opacity 150ms' }}
    >
      {loading && <div className="h-full bg-brand-red animate-loading-bar" />}
    </div>
  )
}
