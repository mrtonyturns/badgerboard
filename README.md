# Wisconsin Political Intelligence Platform
### The Bluejack Group

A full-stack political intelligence platform for tracking Wisconsin elected offices, candidates, elections, and generating AI-powered prospecting lists and political dossiers.

---

## 🚀 Deployment Setup (Step-by-Step)

### Step 1 — Supabase Setup

1. Log in to [supabase.com](https://supabase.com) and open your project (or create a new one).
2. Go to the **SQL Editor** in your Supabase dashboard.
3. Copy the entire contents of `supabase/schema.sql` and paste it into the SQL Editor.
4. Click **Run** — this will create all tables, enable Row Level Security, and seed all Wisconsin offices and elections.
5. Go to **Settings → API** and copy:
   - **Project URL** → this is your `VITE_SUPABASE_URL`
   - **anon / public key** → this is your `VITE_SUPABASE_ANON_KEY`
6. Go to **Authentication → Email** and make sure "Email confirmations" is **enabled**.
7. Create your first user: go to **Authentication → Users → Add User** and enter your work email + a password.

### Step 2 — Local Development Setup

```bash
# Clone / copy the project folder
cd wi-political-tracker

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Then edit .env with your Supabase URL and anon key

# Run locally
npm run dev
```

### Step 3 — Netlify Deployment

1. Push this project to a GitHub repository.
2. Log in to [netlify.com](https://netlify.com) and click **Add new site → Import from Git**.
3. Connect your GitHub repo.
4. Netlify will auto-detect the `netlify.toml` settings (build command: `npm run build`, publish: `dist`).
5. Go to **Site Configuration → Environment Variables** and add:
   ```
   VITE_SUPABASE_URL       = https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY  = your-anon-key-here
   ANTHROPIC_API_KEY       = sk-ant-your-anthropic-key
   ```
6. Click **Deploy site**. Done!

### Step 4 — Get Your Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Navigate to **API Keys** and create a new key.
3. Add it to Netlify as `ANTHROPIC_API_KEY` (see Step 3).

---

## 📁 Project Structure

```
wi-political-tracker/
├── netlify/
│   └── functions/
│       ├── generate-dossier.js        # Claude AI — political dossier generator
│       └── generate-prospecting.js    # Claude AI — prospecting list builder
├── src/
│   ├── components/
│   │   └── Layout.jsx                 # Main app shell with sidebar nav
│   ├── contexts/
│   │   └── AuthContext.jsx            # Supabase auth context
│   ├── lib/
│   │   └── supabase.js               # Supabase client + all DB queries
│   └── pages/
│       ├── Dashboard.jsx              # Intelligence overview
│       ├── Offices.jsx                # All WI political offices
│       ├── Elections.jsx              # Election calendar
│       ├── Candidates.jsx             # Candidate list + add
│       ├── CandidateDetail.jsx        # Full candidate profile
│       ├── Dossiers.jsx               # AI dossier generator + viewer
│       ├── Prospecting.jsx            # AI prospecting list builder
│       ├── Settings.jsx               # App settings
│       └── Login.jsx                  # Auth screen
├── supabase/
│   └── schema.sql                     # Full DB schema + WI seed data
├── .env.example                       # Environment variable template
├── netlify.toml                       # Netlify build config
├── package.json
├── tailwind.config.js
└── vite.config.js
```

---

## 🗂️ What's Pre-Loaded (Seed Data)

The `schema.sql` includes pre-seeded data for:

- **10 Federal offices** — 2 U.S. Senate seats + 8 Congressional districts (WI-1 through WI-8)
- **5 State executive offices** — Governor, Lt. Governor, AG, Secretary of State, Treasurer
- **7 Supreme Court seats** — all 7 Wisconsin Supreme Court positions
- **4 Court of Appeals districts**
- **33 State Senate districts** — all with next-election year noted
- **99 State Assembly districts** — all 99 seats
- **40+ County offices** — executives, DAs, sheriffs for Milwaukee, Dane, Waukesha, Brown, Racine, Outagamie, Kenosha, Marathon, Winnebago, La Crosse, Eau Claire, Sheboygan, Rock counties
- **25+ Municipal offices** — mayors and councils for Milwaukee, Madison, Green Bay, Kenosha, Racine, Appleton, Waukesha, Oshkosh, La Crosse, Eau Claire, Janesville, Superior, Sheboygan, Wausau
- **7 Major school board districts** — Milwaukee, Madison, Green Bay, Kenosha, Racine, Waukesha, Appleton
- **12 Wisconsin elections (2025–2028)** — all spring and fall elections with filing deadlines

---

## 🤖 AI Features

### Political Dossier Generator
- Select any candidate from your database
- Claude generates a structured intelligence report covering: background, political profile, key issues, electoral viability, opposition research notes, outreach recommendations, and research gaps
- Results are saved to Supabase and can be copied or re-generated

### AI Prospecting List Builder
- Filter candidates by level, party, election, and status
- Claude analyzes each candidate and ranks them by strategic priority for The Bluejack Group
- Generates outreach notes for each candidate
- Export as a plain-text file for use in CRM or email outreach

---

## 🔐 Security Notes

- Anthropic API key is server-side only (Netlify Functions) — never exposed to the browser
- Supabase Row Level Security is enabled on all tables — only authenticated users can read/write data
- All routes are protected by Supabase Auth
- Email confirmation is required for new accounts

---

## 📞 Support

Built by The Bluejack Group internal tools team.
