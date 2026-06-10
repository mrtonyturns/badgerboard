/**
 * BadgerBoardLogo — uses the official PNG logo asset.
 *
 * Props:
 *   width     number, default 200
 *   className string
 *
 * The PNG has a black background, so it's designed for dark surfaces.
 * Pass a className with a background override if needed on light surfaces.
 */
export default function BadgerBoardLogo({ width = 200, className = '' }) {
  return (
    <img
      src="/badger-board-logo.png"
      alt="Badger Board"
      width={width}
      className={className}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  )
}
