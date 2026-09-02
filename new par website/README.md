# PAR-MED New Website (Redesign 2025)

This is a modern, fully static redesign of the par-med.com website built for PAR-MED Property Services Inc.

## What's included

- **Modern professional design** — clean typography, generous whitespace, strong medical/real-estate aesthetic
- **Fully responsive** — excellent experience on desktop, tablet, and mobile
- **Interactive portfolio** — filterable property grid with beautiful detail modals
- **Working contact form** — JS-handled (simulated submission — ready to connect to a backend or Formspree)
- **Zero dependencies** — uses Tailwind via CDN + Font Awesome CDN for instant preview and easy deployment
- **No build step required** — just open `index.html` in a browser

## Quick start

1. Open `index.html` in your browser
2. Or serve the folder:
   ```bash
   npx serve "new par website"
   # or
   python -m http.server 8080
   ```

## Project structure

```
new par website/
├── index.html          # Main site (complete single-page experience)
├── css/
│   └── main.css        # Supplemental / override styles
├── js/
│   └── main.js         # Portfolio rendering, modals, form handling
└── README.md
```

## Key pages / sections

- Hero with strong positioning
- Trust metrics
- About + company positioning
- Services for Landlords and Tenants
- Interactive Portfolio (with real addresses from the original site)
- Why Choose PAR-MED
- Professional contact form
- Footer with correct address and contact details

## Customization notes

- Replace placeholder images (`picsum.photos`) with real photography when available
- The contact form currently shows a success state. Connect it to Formspree, Netlify Forms, or your CRM as needed.
- Portfolio data lives in `js/main.js` — easy to extend with more buildings.

## Future enhancement ideas

- Add dedicated subpages (`/about`, `/portfolio`, `/careers`)
- Integrate actual listing data via API
- Add a map view of the portfolio
- Dark mode toggle

---

Built as a clean, contemporary redesign of the original PAR-MED corporate site.

© 2025 PAR-MED Property Services Inc.
