// LoadingBar.jsx — thin animated progress bar shown during data fetches
export default function LoadingBar({ loading }) {
  if (!loading) return null
  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-0.5 bg-gray-100 overflow-hidden">
      <div className="h-full bg-brand-red animate-loading-bar" />
    </div>
  )
}
