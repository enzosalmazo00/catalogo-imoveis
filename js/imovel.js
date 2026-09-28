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
  locationText
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

function formatDistanceMeters(meters){
  const m=Number(meters);
  if(!Number.isFinite(m)||m<0) return "";
  if(m<1000) return `${Math.max(10,Math.round(m/10)*10)} m`;
  return `${(m/1000).toLocaleString("pt-BR",{maximumFractionDigits:1})} km`;
}

function renderUniversities(distances=[]){
  if(!distances.length) return "";

  const rows=distances.map(item=>{
    const distance=formatDistanceMeters(item.distance_m);
    const mapsUrl=String(item.university_maps_url||"").trim();
    return `
      <div class="university-row">
        <div>
          <strong>${escapeHTML(item.university_name||"Faculdade")}</strong>
          ${item.university_address?`<span>${escapeHTML(item.university_address)}</span>`:""}
          ${distance?`<div class="university-distance">📍 Aproximadamente ${escapeHTML(distance)} do imóvel</div>`:""}
        </div>
        ${mapsUrl?`
          <div class="route-modes">
            <a class="btn ghost compact" href="${escapeHTML(mapsUrl)}" target="_blank" rel="noopener">Ver faculdade no mapa</a>
          </div>
        `:""}
      </div>
    `;
  }).join("");

  return `
    <section class="detail-section">
      <div class="section-title-row">
        <div><p class="eyebrow">LOCALIZAÇÃO</p><h2>Faculdades próximas</h2></div>
      </div>
      <div class="university-list">${rows}</div>
      <p class="tiny-note">As distâncias são calculadas internamente usando a localização precisa do imóvel. O endereço e as coordenadas do imóvel não são exibidos ao público.</p>
    </section>
  `;
}

function renderProtectedLocation(){
  return `
    <section class="detail-section protected-location-public">
      <p class="eyebrow">LOCALIZAÇÃO PROTEGIDA</p>
      <h2>Visita acompanhada pelo assessor</h2>
      <p>Por segurança e para preservar a intermediação do imóvel, o endereço exato não é exibido no catálogo. A localização precisa é utilizada somente para cálculos de proximidade e organização da visita.</p>
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

  const [propertyResult, distanceResult] = await Promise.all([
    db
      .from("catalog_properties_public")
      .select("*")
      .eq("id",id)
      .maybeSingle(),
    db.rpc("get_public_property_university_distances",{p_property_id:id})
  ]);

  const property=propertyResult.data;
  const error=propertyResult.error;
  const universityDistances=distanceResult.data||[];

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
        <div class="listing-party-badge ${property.advertiser_role==="owner"?"owner":"broker"}">
          ${property.advertiser_role==="owner"?"🏠 Anunciado pelo proprietário":"🤝 Anunciado por corretor / assessor"}
        </div>
        ${property.advisor_name ? `<p class="detail-advisor">${property.advertiser_role==="owner"?"Responsável pelo anúncio":"Assessor responsável"}: <strong>${escapeHTML(property.advisor_name)}</strong>${property.advisor_company?` · ${escapeHTML(property.advisor_company)}`:""}</p>` : ""}
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
            <div class="feature-item">✓ Anunciante: ${property.advertiser_role==="owner"?"proprietário do imóvel":"corretor / assessor do imóvel"}</div>
            <div class="feature-item">✓ Fechamento: ${property.closing_mode === "direct_owner" ? "direto com o proprietário" : "via assessoria"}</div>
            <div class="feature-item">✓ Caução: ${property.security_deposit_installment_allowed ? (property.security_deposit_max_installments ? `parcelável em até ${property.security_deposit_max_installments}x` : "parcelável") : "não parcelável"}</div>
          </div>
        </section>

        ${renderUniversities(universityDistances)}
        ${renderProtectedLocation()}
      </div>

      <aside class="detail-sidebar">
        <div class="cost-card sticky-card">
          <p class="eyebrow">VALORES</p>
          <div class="cost-row"><span>Aluguel</span><strong>${money(property.price, property.currency)}</strong></div>
          <div class="cost-row"><span>Caução</span><strong>${property.security_deposit != null ? money(property.security_deposit, property.currency) : "Sob consulta"}</strong></div>
          <div class="cost-row"><span>Parcelamento da caução</span><strong>${property.security_deposit_installment_allowed ? (property.security_deposit_max_installments ? `Até ${property.security_deposit_max_installments}x` : "Parcelável") : "Não parcelável"}</strong></div>
          <div class="cost-row"><span>Fechamento</span><strong>${property.closing_mode === "direct_owner" ? "Direto com o proprietário" : "Via assessoria"}</strong></div>
          <div class="cost-row advisory-fee-row ${property.has_advisory_fee?"charged":"free"}"><span>Taxa de assessoria</span><strong>${property.has_advisory_fee ? (property.advisory_fee != null ? money(property.advisory_fee, property.currency) : "Informada pelo assessor") : "Não possui"}</strong></div>
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
