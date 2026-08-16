// src/lib/password.js — ONE password strength scorer.
//
// Three byte-identical copies had accumulated: src/pages/Login.jsx (signup),
// src/pages/ResetPassword.jsx and src/pages/settings/SecurityPane.jsx. Three
// copies of a rule that gates account security is three chances for the rules
// to drift — SecurityPane already shipped a 12-character minimum once while
// signup allowed 8, so a password the user had just been given was rejected the
// first time they tried to change it.
//
// Scoring behaviour is UNCHANGED from the copies. tests/tier3a.test.mjs pins
// the score/label/color/pct for a spread of inputs.
//
// The strength BARS are deliberately NOT here: Login/ResetPassword render a
// Tailwind bar and SecurityPane renders an inline-styled one with different
// hint copy. Only the scoring is genuinely identical, so only the scoring is
// shared.

/** Shortest password any form accepts. Login, ResetPassword and SecurityPane
 *  all enforce this — it is the `minLength` on the inputs too. */
export const PASSWORD_MIN_LENGTH = 8

/** Lowest score any form accepts: 3 = "Fair". Below this, the form refuses. */
export const PASSWORD_MIN_SCORE = 3

/**
 * @param {string} pw
 * @returns {{score:number, label:string, color:string, pct:number}}
 *   An empty password scores 0 with an empty label/color, which is how the
 *   bars know to render nothing.
 */
export function scorePassword(pw) {
  if (!pw) return { score: 0, label: '', color: '', pct: 0 }
  let score = 0
  if (pw.length >= 8)          score++
  if (pw.length >= 12)         score++
  if (/[A-Z]/.test(pw))        score++
  if (/[a-z]/.test(pw))        score++
  if (/[0-9]/.test(pw))        score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (score <= 2) return { score, label: 'Weak',   color: '#ef4444', pct: 25  }
  if (score <= 3) return { score, label: 'Fair',   color: '#f97316', pct: 50  }
  if (score <= 4) return { score, label: 'Good',   color: '#eab308', pct: 75  }
  return             { score, label: 'Strong', color: '#22c55e', pct: 100 }
}
