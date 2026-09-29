import { db } from "./config.js";
import {
  $,
  escapeHTML,
  money,
  propertyTypeLabel,
  coverUrl,
  getSettings,
  locationText
} from "./common.js?v=202609281430";

let properties = [];
let settings = null;\nconst OFFICIAL_SITE_NAME = "Catálogo Imóveis";
const pageParams=new URLSearchParams(location.search);
const advisorCatalogCode=String(pageParams.get("catalogo")||"").trim();

function propertyDetailUrl(propertyId){
  const url=new URL("imovel.html",location.href);
  url.searchParams.set("id",propertyId);
  if(advisorCatalogCode) url.searchParams.set("catalogo",advisorCatalogCode);
  else url.searchParams.delete("catalogo");
  return url.pathname.split("/").pop()+url.search;
}

function normalize(text="") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function nearestUniversityBadgeText(property) {
  const name=String(property?.nearest_university_name||"").trim();
  const meters=Number(property?.nearest_university_distance_m);
  if(!name || !Number.isFinite(meters) || meters<0) return "";

  const distance=meters<1000
    ? `${Math.max(10,Math.round(meters/10)*10)} m`
    : `${(meters/1000).toLocaleString("pt-BR",{maximumFractionDigits:1})} km`;

  return `${distance} da ${name}`;
}

function renderCard(property) {
  const cover = coverUrl(property.property_media || []);
  const rented = property.status === "rented";

  const detailUrl=propertyDetailUrl(property.id);

  return `
    <article class="property-card">
      <a class="property-photo-wrap" href="${escapeHTML(detailUrl)}" aria-label="Ver detalhes de ${escapeHTML(property.title)}">
        ${cover
          ? `<img class="property-photo" src="${escapeHTML(cover)}" alt="${escapeHTML(property.title)}" loading="lazy">`
          : `<div class="property-photo placeholder-photo"><span>Sem foto</span></div>`
        }
        <div class="property-type-pill">${escapeHTML(propertyTypeLabel(property.property_type))}</div>
        ${property.city ? `<div class="property-city-pill">${escapeHTML(property.city)}</div>` : ""}
        ${nearestUniversityBadgeText(property) ? `<div class="property-nearest-university-pill" title="${escapeHTML(nearestUniversityBadgeText(property))}">🎓 ${escapeHTML(nearestUniversityBadgeText(property))}</div>` : ""}
        ${Number(property.catalog_priority||0)>0 ? '<div class="owner-priority-pill">★ Destaque</div>' : (property.featured ? '<div class="featured-pill">Destaque</div>' : "")}
        ${rented ? '<div class="rented-ribbon">ALUGADO</div>' : ""}
      </a>

      <div class="property-card-body">
        <div class="property-location">⌖ ${escapeHTML(locationText(property))}</div>
        <div class="property-public-code">${escapeHTML(property.public_code||"")}</div>
        <h3>${escapeHTML(property.title)}</h3>
        <div class="property-commercial-tags">
          <span>${property.advertiser_role==="owner"?"🏠 Proprietário":"🤝 Corretor / assessor"}</span>
          ${property.has_advisory_fee
            ? `<span class="fee">Assessoria: ${property.advisory_fee!=null?money(property.advisory_fee,property.currency):"sob consulta"}</span>`
            : '<span>Sem taxa de assessoria</span>'}
        </div>

        <div class="property-facts">
          <span>🛏 ${property.bedrooms ?? 0} quarto${Number(property.bedrooms) === 1 ? "" : "s"}</span>
          <span>🚿 ${property.bathrooms ?? 0} banheiro${Number(property.bathrooms) === 1 ? "" : "s"}</span>
          <span>🛋 ${property.furnished ? "Mobiliado" : "Sem mobília"}</span>
        </div>

        <div class="property-card-footer">
          <div>
            <small>Aluguel</small>
            <strong>${money(property.price, property.currency)}<em>/mês</em></strong>
          </div>
          <a class="btn primary compact" href="${escapeHTML(detailUrl)}">Ver detalhes</a>
        </div>
      </div>
    </article>
  `;
}

function applyFilters() {
  const location = normalize($("#fLocation").value);
  const type = $("#fType").value;
  const furnished = $("#fFurnished").value;
  const bedrooms = $("#fBedrooms").value;
  const min = $("#fMin").value === "" ? null : Number($("#fMin").value);
  const max = $("#fMax").value === "" ? null : Number($("#fMax").value);

  let filtered = properties.filter(property => {
    const haystack = normalize([
      property.title,
      property.neighborhood,
      property.city
    ].filter(Boolean).join(" "));

    if (location && !haystack.includes(location)) return false;
    if (type && property.property_type !== type) return false;
    if (furnished === "yes" && !property.furnished) return false;
    if (furnished === "no" && property.furnished) return false;
    if (bedrooms !== "" && Number(property.bedrooms || 0) < Number(bedrooms)) return false;
    if (min != null && Number(property.price) < min) return false;
    if (max != null && Number(property.price) > max) return false;
    return true;
  });

  const sort = $("#sortBy").value;
  if (sort === "priceAsc") {
    filtered.sort((a,b) => Number(a.price) - Number(b.price));
  } else if (sort === "priceDesc") {
    filtered.sort((a,b) => Number(b.price) - Number(a.price));
  } else {
    filtered.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  }

  $("#resultCount").textContent = `${filtered.length} imóvel${filtered.length === 1 ? "" : "is"} encontrado${filtered.length === 1 ? "" : "s"}`;
  $("#propertyGrid").innerHTML = filtered.map(renderCard).join("");
  $("#emptyState").classList.toggle("hidden", filtered.length > 0);
}

async function load() {
  settings = await getSettings();

  $("#brandName").textContent = OFFICIAL_SITE_NAME;
  $("#footerName").textContent = OFFICIAL_SITE_NAME;
  $("#heroTitle").textContent = "CATÁLOGO";
  $("#heroSubtitle").textContent = "Encontre, anuncie e alugue com praticidade";

  let query=db
    .from("catalog_properties_public")
    .select("*")
    .eq("status","available");

  if(advisorCatalogCode){
    query=query.eq("advisor_catalog_code",advisorCatalogCode);
  }

  const { data, error } = await query
    .order("catalog_priority", { ascending: false })
    .order("featured", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) {
    $("#resultCount").textContent = "Não foi possível carregar os imóveis.";
    $("#propertyGrid").innerHTML = `<div class="error-card">${escapeHTML(error.message)}</div>`;
    return;
  }

  properties = data || [];

  const notice=$("#advisorCatalogNotice");
  if(advisorCatalogCode && notice){
    const first=properties[0]||null;
    const displayName=first?.advisor_company || first?.advisor_name || "este assessor";
    $("#advisorCatalogName").textContent=displayName;
    $("#advisorCatalogDescription").textContent=`Você está vendo somente os imóveis publicados por ${displayName}.`;
    notice.classList.remove("hidden");
    $("#generalCatalogTitle").textContent="Imóveis deste assessor";
    document.title=`Catálogo de ${displayName} | ${OFFICIAL_SITE_NAME}`;
  }else if(notice){
    notice.classList.add("hidden");
    $("#generalCatalogTitle").textContent="Imóveis para locação";
  }

  applyFilters();
}

$("#filterForm").addEventListener("submit", event => {
  event.preventDefault();
  applyFilters();
});

$("#sortBy").addEventListener("change", applyFilters);

$("#clearFilters").addEventListener("click", () => {
  $("#filterForm").reset();
  $("#sortBy").value = "recent";
  applyFilters();
});

load();
