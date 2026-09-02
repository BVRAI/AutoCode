// Joan Sinclair Modern Website - Supporting JavaScript

// All major functionality is handled inline in index.html for simplicity.
// This file exists for future expansion (e.g. analytics, more advanced interactions).

document.addEventListener('DOMContentLoaded', function() {
  // Future enhancements can be added here:
  // - Lightbox for testimonials
  // - Booking calendar integration
  // - Analytics events
  console.log('%c[JS Website] Supporting script ready.', 'color:#6b766f; font-size: 10px');
});

// Optional exported helper (in case you want to extend later)
window.JoanSinclairWebsite = {
  scrollToSection: function(id) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
};
