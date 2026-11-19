# BadgerBoard design (v2.0 facelift, Nov 2026)

BadgerBoard shares its look with mycandidatepage.com, the Bluejack Group's
campaign-site builder, so the candidate products read as one family. The
reference is mycandidatepage's own dashboard: "What would you like to see?"
over a grid of big tiles.

## Tokens

| Token | Value | Use |
|---|---|---|
| `brand-gray` | `#F7F8FA` | page wash (the ground every tile sits on) |
| `brand-ink` | `#11161C` | text, dark buttons, active pills |
| `brand-ink-deep` | `#0B0F14` | the floating top bar |
| `brand-navy` | `#0E1A3A` | the one dark hero tile per screen |
| `brand-red` | `#C0392B` | accent: primary buttons, countdowns, "new" dots |
| `brand-red-wash` | `#FBEDEB` | tinted backgrounds for red things |
| `brand-mute` / `brand-faint` | `#5B636C` / `#9099A1` | secondary / tertiary text |
| `shadow-e1`…`e5` | hairline ring + soft drop | elevation; tiles use `e2`, hover `e4` |
| `rounded-tile` | 20px | tiles; buttons and inputs use `rounded-xl` |

Type is DM Sans. Titles are weight 800 with tight tracking (`.display`,
`tracking-display`). Big numbers are the loudest thing on a tile; the words
around them are small and muted.

## The tile kit — `src/components/ui.jsx`

`PageHead`, `Tile` (`dark` for the navy hero), `TileHead` (icon chip + title),
`IconChip`, `BigNumber`, `OpenCue`, `CountBadge`, `Segmented`, `Avatar`,
`EmptyState`, `Button`. `ICON_COLORS` names what kind of thing a tile is:
red people/opponents, ink documents, orange events, purple Broadside, blue
team, green volunteers.

## Rules

- **Tiles, not tables,** when a person has a handful of things. Candidate
  plans track a few people; Action plans keep their dense lists.
- **One dark hero tile per screen at most.** Everything else is white.
- **Big and bold for what matters.** If a section has one job (attack lines,
  this week's to-dos), make it big cards, not a bulleted list.
- **Color carries meaning.** Board columns get a colored top edge
  (mycandidatepage's Sign-ups board); event/kind tiles get a solid color.
- **No dead data.** If a value is unknown, leave the field out or say plainly
  what will fill it. Never show a wall of "Not on file".
- **Plain words.** Name things the way a candidate would. Buttons say what
  happens.
- Every screen works at 390px wide.
