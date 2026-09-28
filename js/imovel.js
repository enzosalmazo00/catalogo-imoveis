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
} from "./common.js?v=202609281430";

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

function straightLineKm(lat1,lon1,lat2,lon2){
  const nums=[lat1,lon1,lat2,lon2].map(Number);
  if(nums.some(v=>!Number.isFinite(v))) return null;
  const [a,b,c,d]=nums;
  const toRad=x=>x*Math.PI/180;
  const earth=6371;
  const dLat=toRad(c-a);
  const dLon=toRad(d-b);
  const h=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
  return 2*earth*Math.asin(Math.sqrt(h));
}

function formatDistanceKm(km){
  if(km==null) return "";
  if(km<1) return `${Math.max(1,Math.round(km*1000))} m`;
  return `${km.toLocaleString("pt-BR",{maximumFractionDigits:1})} km`;
}

function renderUniversities(property, universities = []) {
  if (!universities.length) return "";

  const origin = mapsQuery(property);
  if (!origin) return "";

  const cached = new Map(
    (property.property_university_routes || [])
      .filter(route => route.university_id)
      .map(route => [route.university_id, route])
  );

  const rows = universities
    .filter(uni => uni.active !== false)
    .sort((a,b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)))
    .map(uni => {
      const route = cached.get(uni.id);
      const drive = route ? routeText(route.driving_distance_m, route.driving_duration_s) : "";
      const walk = route ? routeText(route.walking_distance_m, route.walking_duration_s) : "";
      const approxKm = straightLineKm(property.latitude,property.longitude,uni.latitude,uni.longitude);
      const destination = (uni.latitude != null && uni.longitude != null)
        ? `${uni.latitude},${uni.longitude}`
        : uni.address;
      if (!destination) return "";

      const drivingUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
      const walkingUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=walking`;

      return `
        <div class="university-row">
          <div>
            <strong>${escapeHTML(uni.name)}</strong>
            <span>${escapeHTML(uni.address || "")}</span>
            ${approxKm!=null?`<div class="university-distance">📍 Aproximadamente ${escapeHTML(formatDistanceKm(approxKm))} do imóvel</div>`:""}
            ${drive || walk ? `
              <div class="cached-route-info">
                ${drive ? `<span>🚗 ${escapeHTML(drive)}</span>` : ""}
                ${walk ? `<span>🚶 ${escapeHTML(walk)}</span>` : ""}
              </div>
            ` : ""}
          </div>
          <div class="route-modes">
            <a class="btn ghost compact" href="${drivingUrl}" target="_blank" rel="noopener">🚗 Rota de carro</a>
            <a class="btn ghost compact" href="${walkingUrl}" target="_blank" rel="noopener">🚶 Rota a pé</a>
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
      <p class="tiny-note">A distância exibida é aproximada pelas coordenadas do imóvel e da faculdade. O botão de rota abre o Google Maps para calcular o percurso real pelas ruas e o tempo atualizado.</p>
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

  const [propertyResult, universitiesResult] = await Promise.all([
    db
    .from("properties")
    .select(`
      *,
      property_media(*),
      property_features(feature_id, features(*)),
      property_university_routes(*, universities(*))
    `)
    .eq("id", id)
    .maybeSingle(),
    db.from("universities").select("*").eq("active", true).order("sort_order").order("name")
  ]);

  const property = propertyResult.data;
  const error = propertyResult.error;
  const universities = universitiesResult.data || [];

  if (error || !property) {
    $("#detailRoot").innerHTML = '<div class="error-card">Este imóvel não está disponível no catálogo.</div>';
    return;
  }

  document.title = `${property.title} | ${settings.site_name}`;

  const furniture = featureList(property, "furniture");
  const included = featureList(property, "included");
  const security = featureList(property, "security");
  const nearby = featureList(property, "nearby");
  const wa = whatsappLink(settings, property);
  const waEnabled = property.status !== "rented" && wa !== "#";

  $("#detailRoot").innerHTML = `
    <div class="detail-breadcrumb"><a href="index.html">Início</a><span>›</span><span>${escapeHTML(propertyTypeLabel(property.property_type))}</span></div>

    <section class="detail-hero">
      <div>
        <div class="detail-badges">
          <span class="status-chip ${property.status}">${escapeHTML(statusLabel(property.status))}</span>
          <span class="type-chip">${escapeHTML(propertyTypeLabel(property.property_type))}</span>
          ${property.public_code ? `<span class="type-chip">Código: ${escapeHTML(property.public_code)}</span>` : ""}
          ${property.city ? `<span class="type-chip city-chip">${escapeHTML(property.city)}</span>` : ""}
          ${property.furnished ? '<span class="type-chip">Mobiliado</span>' : '<span class="type-chip">Sem mobília</span>'}
        </div>
        <h1>${escapeHTML(property.title)}</h1>
        <p class="detail-location">⌖ ${escapeHTML(locationText(property))}</p>
        ${property.advisor_name ? `<p class="detail-advisor">Assessor responsável: <strong>${escapeHTML(property.advisor_name)}</strong>${property.advisor_company?` · ${escapeHTML(property.advisor_company)}`:""}</p>` : ""}
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

        <section class="detail-section">
          <p class="eyebrow">FICHA TÉCNICA</p><h2>Configuração e acesso</h2>
          <div class="feature-grid">
            <div class="feature-item">🏠 ${property.housing_context==="condominium" ? `Condomínio${property.condominium_name?`: ${escapeHTML(property.condominium_name)}`:""}` : "Imóvel independente"}</div>
            <div class="feature-item">↩️ Imóvel de fundo: ${property.is_rear_unit?"Sim":"Não"}</div>
            <div class="feature-item">🪜 Escada para acesso: ${property.has_stairs_access?"Sim":"Não"}</div>
            <div class="feature-item">🧺 Lavanderia: ${property.laundry_type==="private"?"Privativa":property.laundry_type==="shared"?"Compartilhada":"Não possui"}</div>
            <div class="feature-item">🚗 Garagem: ${property.garage_scope==="private"?"Própria / privativa":property.garage_scope==="shared"?"Coletiva / compartilhada":"Não possui"}</div>
            ${property.garage_scope!=="none" ? `<div class="feature-item">🚘 Uso da garagem: ${property.garage_vehicle==="car_motorcycle"?"Carro e moto":property.garage_vehicle==="car"?"Somente carro":property.garage_vehicle==="motorcycle"?"Somente moto":"Não informado"}</div>` : ""}
            ${property.garage_scope!=="none" ? `<div class="feature-item">🔐 Portão eletrônico: ${property.has_electronic_gate?"Sim":"Não"}</div>` : ""}
          </div>
        </section>

        ${property.property_type!=="monoambiente" ? `
          <section class="detail-section">
            <p class="eyebrow">DISTRIBUIÇÃO</p><h2>Cômodos do imóvel</h2>
            <div class="facts-grid">
              <div class="fact-box"><span>Total de cômodos</span><strong>${property.room_count??"Não informado"}</strong></div>
              <div class="fact-box"><span>Sala</span><strong>${property.has_living_room?"Sim":"Não"}</strong></div>
              <div class="fact-box"><span>Cozinha</span><strong>${property.has_kitchen?"Sim":"Não"}</strong></div>
              <div class="fact-box"><span>Lavanderia</span><strong>${property.laundry_type==="private"?"Privativa":property.laundry_type==="shared"?"Compartilhada":"Não"}</strong></div>
            </div>
          </section>
        ` : ""}

        ${security.length ? `
          <section class="detail-section">
            <p class="eyebrow">SEGURANÇA</p><h2>Recursos de segurança</h2>
            <div class="feature-grid">${security.map(item => `<div class="feature-item">${escapeHTML(item.icon||"✓")} ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        ${nearby.length ? `
          <section class="detail-section">
            <p class="eyebrow">PROXIMIDADES</p><h2>Comodidades por perto</h2>
            <div class="feature-grid">${nearby.map(item => `<div class="feature-item">${escapeHTML(item.icon||"✓")} ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

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

        <section class="detail-section">
          <p class="eyebrow">CONDIÇÕES</p><h2>Condições do imóvel</h2>
          <div class="feature-grid">
            <div class="feature-item">✓ Fechamento: ${property.closing_mode === "direct_owner" ? "direto com o proprietário" : "via assessoria"}</div>
            <div class="feature-item">✓ Caução: ${property.security_deposit_installment_allowed ? (property.security_deposit_max_installments ? `parcelável em até ${property.security_deposit_max_installments}x` : "parcelável") : "não parcelável"}</div>
          </div>
        </section>

        ${renderUniversities(property, universities)}
        ${renderMap(property)}
      </div>

      <aside class="detail-sidebar">
        <div class="cost-card sticky-card">
          <p class="eyebrow">VALORES</p>
          <div class="cost-row"><span>Aluguel</span><strong>${money(property.price, property.currency)}</strong></div>
          <div class="cost-row"><span>Caução</span><strong>${property.security_deposit != null ? money(property.security_deposit, property.currency) : "Sob consulta"}</strong></div>
          <div class="cost-row"><span>Parcelamento da caução</span><strong>${property.security_deposit_installment_allowed ? (property.security_deposit_max_installments ? `Até ${property.security_deposit_max_installments}x` : "Parcelável") : "Não parcelável"}</strong></div>
          <div class="cost-row"><span>Fechamento</span><strong>${property.closing_mode === "direct_owner" ? "Direto com o proprietário" : "Via assessoria"}</strong></div>
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
