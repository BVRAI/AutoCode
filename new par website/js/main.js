// PAR-MED Modern Website - Portfolio & Interaction Logic

const properties = [
  {
    id: 1,
    title: "2115 Finch Avenue West",
    address: "2115 Finch Avenue West",
    city: "North York",
    region: "toronto",
    size: "124,000 sq ft",
    tenants: "Multi-specialty medical centre",
    year: "2007",
    description: "Large medical office building anchored by diagnostic imaging and multiple physician practices. Excellent access to Highway 400 and Finch West subway.",
    highlights: ["24/7 security", "On-site pharmacy", "Ample patient parking", "Recently upgraded HVAC"]
  },
  {
    id: 2,
    title: "2863 Ellesmere Road",
    address: "2863 Ellesmere Road",
    city: "Scarborough",
    region: "gta",
    size: "78,500 sq ft",
    tenants: "Family medicine + specialists",
    year: "1999",
    description: "Well-maintained community medical building with strong tenant mix and consistent performance. Close to Scarborough General Hospital.",
    highlights: ["Strong patient flow", "Multiple elevator banks", "Dedicated loading area"]
  },
  {
    id: 3,
    title: "377 Church Street",
    address: "377 Church Street",
    city: "Markham",
    region: "gta",
    size: "92,000 sq ft",
    tenants: "Specialist clinic & labs",
    year: "2011",
    description: "Modern Class A medical office in the heart of Markham. Built to support high-acuity tenants including procedural suites.",
    highlights: ["LEED Silver certified", "Fibre optic throughout", "Medical gas infrastructure"]
  },
  {
    id: 4,
    title: "672 Brant Street",
    address: "672 Brant Street",
    city: "Burlington",
    region: "west",
    size: "65,000 sq ft",
    tenants: "Primary care + allied health",
    year: "2004",
    description: "Popular medical office in downtown Burlington with outstanding visibility and parking ratio. Strong mix of family physicians and specialists.",
    highlights: ["High occupancy", "Recently renovated lobby", "Excellent parking"]
  },
  {
    id: 5,
    title: "38 Victoria Street East",
    address: "38 Victoria Street East",
    city: "Alliston",
    region: "west",
    size: "42,000 sq ft",
    tenants: "Regional health services",
    year: "2015",
    description: "Purpose-built medical facility serving the growing Alliston community. Anchored by regional health services and diagnostic imaging.",
    highlights: ["Newer construction", "Large floor plates", "Ample surface parking"]
  },
  {
    id: 6,
    title: "55 Athol Street East",
    address: "55 Athol Street East",
    city: "Oshawa",
    region: "gta",
    size: "87,000 sq ft",
    tenants: "Specialist practices",
    year: "1995",
    description: "Established medical office property just minutes from Lakeridge Health. Recently underwent common area and lobby upgrades.",
    highlights: ["Downtown location", "Strong long-term tenants", "Major renovation 2023"]
  },
  {
    id: 7,
    title: "1200 Lawrence Avenue West",
    address: "1200 Lawrence Avenue West",
    city: "North York",
    region: "toronto",
    size: "54,000 sq ft",
    tenants: "Multi-tenant medical",
    year: "1987",
    description: "Longstanding medical office with diverse tenant roster. Recently upgraded common areas and mechanical systems.",
    highlights: ["Strong cash flow", "Low vacancy", "Value-add opportunity"]
  },
  {
    id: 8,
    title: "101 Queensway West",
    address: "101 Queensway West",
    city: "Mississauga",
    region: "west",
    size: "110,000 sq ft",
    tenants: "Hospital-aligned practices",
    year: "2009",
    description: "Premium medical building directly adjacent to Trillium Health Partners. High demand location with excellent tenant quality.",
    highlights: ["Connected to hospital campus", "High parking ratio", "Advanced building systems"]
  }
];

// Render all portfolio cards
function renderPortfolio(filter = 'all') {
  const grid = document.getElementById('portfolio-grid');
  if (!grid) return;

  grid.innerHTML = '';

  const filtered = filter === 'all' 
    ? properties 
    : properties.filter(p => p.region === filter);

  filtered.forEach(property => {
    const card = document.createElement('div');
    card.className = 'property-card bg-white border border-slate-200 rounded-3xl overflow-hidden group cursor-pointer';
    
    card.innerHTML = `
      <div class="h-52 bg-slate-200 relative overflow-hidden">
        <img src="https://picsum.photos/id/${(property.id * 7) % 50 + 10}/800/600" 
             alt="${property.title}"
             class="w-full h-full object-cover group-hover:scale-[1.05] transition duration-500">
        <div class="absolute top-4 left-4">
          <div class="inline-flex items-center px-3 py-1 text-[10px] font-semibold tracking-wider rounded-2xl bg-white/90 text-teal-700 shadow-sm">
            ${property.city}
          </div>
        </div>
      </div>
      
      <div class="p-6">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="font-semibold text-lg tracking-tight leading-tight">${property.title}</div>
            <div class="text-sm text-slate-500">${property.address}</div>
          </div>
        </div>
        
        <div class="mt-4 text-sm flex items-center gap-x-3 text-slate-600">
          <div><i class="fa-solid fa-expand text-xs mr-1.5"></i>${property.size}</div>
        </div>
        
        <div class="mt-4 pt-4 border-t flex items-center justify-between">
          <div class="text-xs text-teal-600 font-medium">VIEW DETAILS →</div>
          <div class="text-xs text-slate-500">${property.year}</div>
        </div>
      </div>
    `;
    
    card.addEventListener('click', () => showPropertyModal(property));
    grid.appendChild(card);
  });
}

function filterPortfolio(region) {
  const grid = document.getElementById('portfolio-grid');
  if (!grid) return;

  const cards = grid.querySelectorAll('.property-card');
  const filteredProperties = region === 'all' 
    ? properties 
    : properties.filter(p => p.region === region);

  // Simple filter approach - re-render for cleanliness
  renderPortfolio(region);
}

function showPropertyModal(property) {
  const modal = document.getElementById('property-modal');
  const titleEl = document.getElementById('modal-title');
  const cityEl = document.getElementById('modal-city');
  const detailsEl = document.getElementById('modal-details');

  if (!modal || !titleEl || !cityEl || !detailsEl) return;

  titleEl.textContent = property.title;
  cityEl.textContent = `${property.city.toUpperCase()} • ${property.size}`;

  detailsEl.innerHTML = `
    <div>
      <div class="text-xs uppercase tracking-widest font-medium text-slate-500">ADDRESS</div>
      <div class="font-medium mt-1">${property.address}</div>
    </div>
    
    <div class="pt-4">
      <div class="text-xs uppercase tracking-widest font-medium text-slate-500">KEY TENANTS</div>
      <div class="font-medium mt-1">${property.tenants}</div>
    </div>

    <div class="pt-4">
      <div class="text-xs uppercase tracking-widest font-medium text-slate-500 mb-1">DESCRIPTION</div>
      <div class="text-sm text-slate-600 leading-relaxed">${property.description}</div>
    </div>

    <div class="pt-4">
      <div class="text-xs uppercase tracking-widest font-medium text-slate-500 mb-2">HIGHLIGHTS</div>
      <div class="flex flex-wrap gap-2">
        ${property.highlights.map(h => 
          `<div class="text-xs px-3 py-1 bg-teal-50 text-teal-700 rounded-2xl">${h}</div>`
        ).join('')}
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModal() {
  const modal = document.getElementById('property-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

// Public helper for the "view entire portfolio" button in HTML
function showFullPortfolio() {
  const grid = document.getElementById('portfolio-grid');
  if (grid) {
    // Reset filter and render all
    document.querySelectorAll('.portfolio-filter-btn').forEach(b => b.classList.remove('active', 'border-teal-600', 'text-teal-600'));
    document.querySelectorAll('.portfolio-filter-btn').forEach(b => b.classList.add('border-slate-300', 'text-slate-600'));
    
    const allBtn = document.querySelector('[data-filter="all"]');
    if (allBtn) {
      allBtn.classList.add('active', 'border-teal-600', 'text-teal-600');
      allBtn.classList.remove('border-slate-300', 'text-slate-600');
    }
    
    renderPortfolio('all');
    
    // Scroll to portfolio
    grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Make important functions globally available for inline onclick
window.showPropertyModal = showPropertyModal;
window.closeModal = closeModal;
window.showFullPortfolio = showFullPortfolio;
window.renderPortfolio = renderPortfolio; // helpful for console debugging
