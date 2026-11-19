// src/pages/candidates/Portrait.jsx — a candidate's photo, or their initials.
// Photos are arbitrary https links (the share image on a campaign site, or a
// pasted headshot), so they load through the same-origin Netlify image proxy
// the Events page uses — the CSP's img-src stays strict, and a dead link falls
// back to the initials disc instead of a broken-image icon.

import { useState } from 'react'
import { eventImage } from '../../lib/imageProxy'
import { Avatar } from '../../components/ui'

const cx = (...a) => a.filter(Boolean).join(' ')

export default function Portrait({ name, photo, size = 88, color, className = '' }) {
  const [broken, setBroken] = useState(null)   // the photo URL that failed
  const src = photo && broken !== photo ? eventImage(photo, size * 2) : null
  if (src) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(photo)}
        className={cx('flex-shrink-0 rounded-full bg-white object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }
  return <Avatar name={name} size={size} color={color} className={className} />
}
