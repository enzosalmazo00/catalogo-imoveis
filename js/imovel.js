import { db } from "./config.js";
import {
  $,
  escapeHTML,
  money,
  propertyTypeLabel,
  statusLabel,
  allImageUrls,
  youtubeEmbed,
  getSettings,
  whatsappLink,
  locationText,
  routeText,
  mapsQuery
} from "./common.js";

const params = new URLSearchParams(location.search);
const id = params.get("id");

function featureList(property, category) {
  return (property.property_features || [])
    .map(item => item.features)
    .filter(Boolean)
    .filter(item => item.category === category)
    .sort((a,b) => (a.sort_order || 0) - (b.sort_order || 0));
}

function renderGallery(property) {
  const images = allImageUrls(property.property_media || []);
  const videos = (property.property_media || [])
    .filter(item => item.media_type === "youtube")
    .map(item => ({...item, embed: youtubeEmbed(item.external_url)}))
    .filter(item => item.embed);

  if (!images.length && !videos.length) {
    return '<div class="detail-empty-media">Nenhuma foto cadastrada.</div>';
  }

  const first = images[0];
  const thumbs = images.map((img, index) => `
    <button class="gallery-thumb ${index === 0 ? "active" : ""}" type="button" data-image="${escapeHTML(img.url)}">
      <img src="${escapeHTML(img.url)}" alt="${escapeHTML(img.alt_text || property.title)}">
    </button>
  `).join("");

  const videoCards = videos.map(video => `
    <div class="video-frame">
      <iframe src="${escapeHTML(video.embed)}" title="Vídeo do imóvel" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    </div>
  `).join("");

  return `
    <div class="gallery-shell">
      ${first ? `
        <div class="main-photo-shell">
          <img id="mainPropertyImage" class="main-property-image" src="${escapeHTML(first.url)}" alt="${escapeHTML(first.alt_text || property.title)}">
          ${property.status === "rented" ? '<div class="rented-ribbon large">ALUGADO</div>' : ""}
        </div>
        <div class="gallery-thumbs">${thumbs}</div>
      ` : ""}
      ${videoCards}
    </div>
  `;
}

function renderUniversities(property) {
  const routes = (property.property_university_routes || [])
    .filter(route => route.universities)
    .sort((a,b) => (a.universities.sort_order || 0) - (b.universities.sort_order || 0));

  if (!routes.length) return "";

  const rows = routes.map(route => {
    const uni = route.universities;
    const drive = routeText(route.driving_distance_m, route.driving_duration_s);
    const walk = routeText(route.walking_distance_m, route.walking_duration_s);
    if (!drive && !walk) return "";
    return `
      <div class="university-row">
        <div>
          <strong>${escapeHTML(uni.name)}</strong>
          <span>${escapeHTML(uni.address)}</span>
        </div>
        <div class="route-modes">
          ${drive ? `<span>🚗 ${escapeHTML(drive)}</span>` : ""}
          ${walk ? `<span>🚶 ${escapeHTML(walk)}</span>` : ""}
        </div>
      </div>
    `;
  }).filter(Boolean).join("");

  if (!rows) return "";

  return `
    <section class="detail-section">
      <div class="section-title-row">
        <div><p class="eyebrow">LOCALIZAÇÃO</p><h2>Universidades próximas</h2></div>
      </div>
      <div class="university-list">${rows}</div>
      <p class="tiny-note">Tempos de caminhada podem variar conforme calçadas, acessos e condições da via.</p>
    </section>
  `;
}

function renderMap(property) {
  const query = mapsQuery(property);
  if (!query) return "";

  const encoded = encodeURIComponent(query);
  return `
    <section class="detail-section">
      <div class="section-title-row">
        <div><p class="eyebrow">MAPA</p><h2>Localização</h2></div>
        <a class="btn ghost compact" href="https://www.google.com/maps/search/?api=1&query=${encoded}" target="_blank" rel="noopener">Abrir no Google Maps</a>
      </div>
      <div class="map-shell">
        <iframe
          src="https://www.google.com/maps?q=${encoded}&output=embed"
          title="Mapa do imóvel"
          loading="lazy"
          referrerpolicy="no-referrer-when-downgrade">
        </iframe>
      </div>
      ${!property.show_exact_location ? '<p class="tiny-note">A localização exibida é aproximada. O endereço exato é informado no atendimento.</p>' : ""}
    </section>
  `;
}

function wireGallery() {
  const main = $("#mainPropertyImage");
  if (!main) return;
  document.querySelectorAll(".gallery-thumb").forEach(button => {
    button.addEventListener("click", () => {
      main.src = button.dataset.image;
      document.querySelectorAll(".gallery-thumb").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
    });
  });
}

async function load() {
  if (!id) {
    $("#detailRoot").innerHTML = '<div class="error-card">Imóvel não informado.</div>';
    return;
  }

  const settings = await getSettings();
  $("#brandName").textContent = settings.site_name;
  $("#footerName").textContent = settings.site_name;

  const { data: property, error } = await db
    .from("properties")
    .select(`
      *,
      property_media(*),
      property_features(feature_id, features(*)),
      property_university_routes(*, universities(*))
    `)
    .eq("id", id)
    .maybeSingle();

  if (error || !property) {
    $("#detailRoot").innerHTML = '<div class="error-card">Este imóvel não está disponível no catálogo.</div>';
    return;
  }

  document.title = `${property.title} | ${settings.site_name}`;

  const furniture = featureList(property, "furniture");
  const included = featureList(property, "included");
  const wa = whatsappLink(settings, property);
  const waEnabled = property.status !== "rented" && wa !== "#";

  $("#detailRoot").innerHTML = `
    <div class="detail-breadcrumb"><a href="index.html">Início</a><span>›</span><span>${escapeHTML(propertyTypeLabel(property.property_type))}</span></div>

    <section class="detail-hero">
      <div>
        <div class="detail-badges">
          <span class="status-chip ${property.status}">${escapeHTML(statusLabel(property.status))}</span>
          <span class="type-chip">${escapeHTML(propertyTypeLabel(property.property_type))}</span>
          ${property.furnished ? '<span class="type-chip">Mobiliado</span>' : '<span class="type-chip">Sem mobília</span>'}
        </div>
        <h1>${escapeHTML(property.title)}</h1>
        <p class="detail-location">⌖ ${escapeHTML(locationText(property))}</p>
      </div>
      <div class="detail-price">
        <span>Aluguel mensal</span>
        <strong>${money(property.price, property.currency)}</strong>
      </div>
    </section>

    ${renderGallery(property)}

    <div class="detail-layout">
      <div class="detail-main">
        <section class="detail-section">
          <p class="eyebrow">CARACTERÍSTICAS</p>
          <h2>Sobre o imóvel</h2>
          <div class="facts-grid">
            <div class="fact-box"><span>Tipo</span><strong>${escapeHTML(propertyTypeLabel(property.property_type))}</strong></div>
            <div class="fact-box"><span>Quartos</span><strong>${property.bedrooms ?? 0}</strong></div>
            <div class="fact-box"><span>Banheiros</span><strong>${property.bathrooms ?? 0}</strong></div>
            <div class="fact-box"><span>Mobília</span><strong>${property.furnished ? "Mobiliado" : "Sem mobília"}</strong></div>
          </div>
          ${property.description ? `<div class="description-text">${escapeHTML(property.description).replace(/\n/g,"<br>")}</div>` : ""}
        </section>

        ${furniture.length ? `
          <section class="detail-section">
            <p class="eyebrow">ESTRUTURA</p><h2>O imóvel possui</h2>
            <div class="feature-grid">${furniture.map(item => `<div class="feature-item">✓ ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        ${included.length ? `
          <section class="detail-section">
            <p class="eyebrow">INCLUSO</p><h2>Incluso no aluguel</h2>
            <div class="feature-grid">${included.map(item => `<div class="feature-item">✓ ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        ${renderUniversities(property)}
        ${renderMap(property)}
      </div>

      <aside class="detail-sidebar">
        <div class="cost-card sticky-card">
          <p class="eyebrow">VALORES</p>
          <div class="cost-row"><span>Aluguel</span><strong>${money(property.price, property.currency)}</strong></div>
          <div class="cost-row"><span>Caução</span><strong>${property.security_deposit != null ? money(property.security_deposit, property.currency) : "Sob consulta"}</strong></div>
          <div class="cost-row"><span>Taxa de assessoria</span><strong>${property.has_advisory_fee ? (property.advisory_fee != null ? money(property.advisory_fee, property.currency) : "Sob consulta") : "Não possui"}</strong></div>
          ${property.status === "rented"
            ? '<div class="rented-notice">Este imóvel está alugado.</div>'
            : waEnabled
              ? `<a class="btn whatsapp full" href="${escapeHTML(wa)}" target="_blank" rel="noopener">💬 Tenho interesse</a>`
              : '<div class="muted center">WhatsApp ainda não configurado.</div>'
          }
        </div>
      </aside>
    </div>
  `;

  wireGallery();
}

load();
