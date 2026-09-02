# Joan Sinclair — Modern Website Redesign

A clean, warm, and professional redesign of the website for Joan Sinclair, MSW, RSW, Acc.FM, CP Med (Family Mediator & Counsellor, Ontario).

## What's New & Improved

- **Much more modern, calm, and trustworthy design**
- Warm, empathetic tone with excellent typography
- Better hierarchy and breathing room
- Clear services breakdown
- Simple "How I Work" process
- Professional testimonials section
- Prominent free consultation CTA
- Fully responsive with mobile navigation
- Working contact form (JS-simulated submission for now)
- Zero build tools required (uses Tailwind via CDN)

## File Structure

```
js_website/
├── index.html          ← Main website (open this)
├── css/
│   └── main.css        ← Small supplemental styles
├── js/
│   └── main.js         ← Supporting JavaScript
└── README.md
```

## How to Use / Preview

### Easiest method:
1. Go into the `js_website` folder
2. Double-click `index.html` — it will open in your browser

### Recommended (better experience):
```bash
# From the project root
npx serve js_website -p 5174
```

Then visit **http://localhost:5174**

This gives you proper HTTP (recommended for any external CDN resources).

## Key Features
- Sticky navigation with mobile hamburger
- Smooth scroll to sections
- Fully functional contact form (shows nice success message)
- All contact info is accurate from her current site
- Ready to connect a real form backend later (Formspree, Netlify Forms, email service, etc.)

## Customization Notes
- Colors are defined in Tailwind + a few custom variables in the CSS file
- Testimonials are currently placeholder (you can replace with real ones)
- The contact form success state is simulated. Replace the form logic in `js/main.js` if you want real email delivery.

## Next Steps (Optional Enhancements)
- Add real photos of Joan
- Integrate Calendly for booking
- Add more detailed case studies or a blog
- Add Google Analytics or simple tracking

---

This redesign aims to feel warm, professional, and human — a significant upgrade from the current dated site while remaining respectful of Joan's established practice.

Let me know if you'd like any adjustments before handing it over!
