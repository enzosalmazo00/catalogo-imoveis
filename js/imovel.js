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
const advisorCatalogCode=String(params.get("catalogo")||"").trim();

function catalogIndexUrl(){
  return advisorCatalogCode ? `index.html?catalogo=${encodeURIComponent(advisorCatalogCode)}` : "index.html";
}

function propertyDetailUrl(propertyId){
  const base=`imovel.html?id=${encodeURIComponent(propertyId)}`;
  return advisorCatalogCode ? `${base}&catalogo=${encodeURIComponent(advisorCatalogCode)}` : base;
}

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
        <div><h2>Faculdades próximas</h2></div>
      </div>
      <div class="university-list">${rows}</div>
      <p class="tiny-note">As distâncias são calculadas internamente usando a localização precisa do imóvel. O endereço e as coordenadas do imóvel não são exibidos ao público.</p>
    </section>
  `;
}

function renderProtectedLocation(){
  return `
    <section class="detail-section protected-location-public">
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

  let propertyQuery=db
    .from("catalog_properties_public")
    .select("*")
    .eq("id",id)
    .eq("status","available");

  let sequenceQuery=db
    .from("catalog_properties_public")
    .select("id,title,public_code,catalog_priority,featured,sort_order,created_at,advisor_catalog_code")
    .eq("status","available");

  if(advisorCatalogCode){
    propertyQuery=propertyQuery.eq("advisor_catalog_code",advisorCatalogCode);
    sequenceQuery=sequenceQuery.eq("advisor_catalog_code",advisorCatalogCode);
  }

  const [propertyResult, distanceResult, sequenceResult] = await Promise.all([
    propertyQuery.maybeSingle(),
    db.rpc("get_public_property_university_distances",{p_property_id:id}),
    sequenceQuery
      .order("catalog_priority",{ascending:false})
      .order("featured",{ascending:false})
      .order("sort_order",{ascending:true})
      .order("created_at",{ascending:false})
      .order("id",{ascending:true})
  ]);

  const property=propertyResult.data;
  const error=propertyResult.error;
  const universityDistances=distanceResult.data||[];
  const catalogSequence=(sequenceResult.data||[]).filter((item,index,array)=>
    array.findIndex(other=>other.id===item.id)===index
  );

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
  const guaranteeType=property.guarantee_type||"deposit";
  const depositCount=Number(property.security_deposit_count||1);
  const depositUnit=Number(property.security_deposit||0);
  const depositTotal=guaranteeType==="deposit"?depositUnit*depositCount:0;
  const minimumTerm=property.minimum_contract_term==="6_months"
    ? "6 meses"
    : property.minimum_contract_term==="12_months"
      ? "1 ano"
      : "Sem tempo mínimo";
  const contractPayer=property.contract_payer==="owner"?"proprietário":"inquilino";

  const currentIndex=catalogSequence.findIndex(item=>item.id===property.id);
  const previousProperty=currentIndex>0 ? catalogSequence[currentIndex-1] : null;
  const nextProperty=currentIndex>=0 && currentIndex<catalogSequence.length-1 ? catalogSequence[currentIndex+1] : null;

  $("#detailRoot").innerHTML = `
    ${advisorCatalogCode?`
      <div class="advisor-catalog-detail-strip">
        <span>Você está navegando no catálogo deste assessor.</span>
        <div>
          <a class="btn ghost compact" href="${escapeHTML(catalogIndexUrl())}">← Voltar aos imóveis deste assessor</a>
          <a class="btn primary compact" href="index.html">Ver todo catálogo do site</a>
        </div>
      </div>
    `:""}
    <div class="detail-breadcrumb"><a href="${escapeHTML(catalogIndexUrl())}">${advisorCatalogCode?"Catálogo do assessor":"Início"}</a><span>›</span><span>${escapeHTML(propertyTypeLabel(property.property_type))}</span></div>

    <section class="detail-hero">
      <div>
        <div class="detail-badges">
          <span class="status-chip ${property.status}">${escapeHTML(statusLabel(property.status))}</span>
          <span class="type-chip">${escapeHTML(propertyTypeLabel(property.property_type))}</span>
          ${property.public_code ? `<span class="type-chip">Código: ${escapeHTML(property.public_code)}</span>` : ""}
          ${Number(property.catalog_priority||0)>0 ? '<span class="type-chip priority-detail-chip">★ Destaque</span>' : ""}
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
          <h2>Configuração e acesso</h2>
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
            <h2>Cômodos do imóvel</h2>
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
            <h2>Recursos de segurança</h2>
            <div class="feature-grid">${security.map(item => `<div class="feature-item">${escapeHTML(item.icon||"✓")} ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        ${nearby.length ? `
          <section class="detail-section">
            <h2>Comodidades por perto</h2>
            <div class="feature-grid">${nearby.map(item => `<div class="feature-item">${escapeHTML(item.icon||"✓")} ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        ${furniture.length ? `
          <section class="detail-section">
            <h2>O imóvel possui</h2>
            <div class="feature-grid">${furniture.map(item => `<div class="feature-item">✓ ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        ${included.length ? `
          <section class="detail-section">
            <h2>Incluso no aluguel</h2>
            <div class="feature-grid">${included.map(item => `<div class="feature-item">✓ ${escapeHTML(item.name)}</div>`).join("")}</div>
          </section>
        ` : ""}

        <section class="detail-section">
          <h2>Condições do imóvel</h2>
          <div class="feature-grid">
            <div class="feature-item">✓ Anunciante: ${property.advertiser_role==="owner"?"proprietário do imóvel":"corretor / assessor do imóvel"}</div>
            <div class="feature-item">✓ Fechamento: ${property.closing_mode === "direct_owner" ? "direto com o proprietário" : "via assessoria"}</div>
            <div class="feature-item">✓ Garantia: ${guaranteeType==="guarantor" ? "fiador" : `${depositCount} caução${depositCount===1?"":"ões"} de ${money(depositUnit,property.currency)} (total ${money(depositTotal,property.currency)})`}</div>
            <div class="feature-item">✓ Tempo mínimo: ${minimumTerm}</div>
            ${property.has_contract
              ? `<div class="feature-item">✓ Contrato: ${money(property.contract_amount||0,property.currency)} • pago pelo ${contractPayer}</div>`
              : '<div class="feature-item">✓ Contrato: não possui cobrança de contrato</div>'}
            ${guaranteeType==="deposit"
              ? `<div class="feature-item">✓ Caução: ${property.security_deposit_installment_allowed ? (property.security_deposit_max_installments ? `parcelável em até ${property.security_deposit_max_installments}x` : "parcelável") : "não parcelável"}</div>`
              : ""}
          </div>
        </section>

        ${renderUniversities(universityDistances)}
        ${renderProtectedLocation()}
      </div>

      <aside class="detail-sidebar">
        <div class="cost-card sticky-card">
          <h2 class="cost-card-title">Valores</h2>
          <div class="cost-row"><span>Aluguel</span><strong>${money(property.price, property.currency)}</strong></div>
          <div class="cost-row"><span>Garantia</span><strong>${guaranteeType==="guarantor"?"Fiador":"Caução"}</strong></div>
          ${guaranteeType==="deposit"?`
            <div class="cost-row"><span>Quantidade de cauções</span><strong>${depositCount}</strong></div>
            <div class="cost-row"><span>Valor de cada caução</span><strong>${money(depositUnit,property.currency)}</strong></div>
            <div class="cost-row"><span>Total das cauções</span><strong>${money(depositTotal,property.currency)}</strong></div>
            <div class="cost-row"><span>Parcelamento da caução</span><strong>${property.security_deposit_installment_allowed ? (property.security_deposit_max_installments ? `Até ${property.security_deposit_max_installments}x` : "Parcelável") : "Não parcelável"}</strong></div>
          `:""}
          <div class="cost-row"><span>Tempo mínimo</span><strong>${minimumTerm}</strong></div>
          ${property.has_contract?`
            <div class="cost-row"><span>Valor do contrato</span><strong>${money(property.contract_amount||0,property.currency)}</strong></div>
            <div class="cost-row"><span>Contrato pago por</span><strong>${contractPayer==="proprietário"?"Proprietário":"Inquilino"}</strong></div>
          `:`
            <div class="cost-row"><span>Contrato</span><strong>Sem cobrança</strong></div>
          `}
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

    <nav class="property-sequence-nav" aria-label="Navegação entre anúncios">
      <a class="property-sequence-btn previous ${previousProperty?"":"disabled"}"
         ${previousProperty?`href="${escapeHTML(propertyDetailUrl(previousProperty.id))}"`:'aria-disabled="true" tabindex="-1"'}>
        <span>← Anterior</span>
        <small>${previousProperty?escapeHTML(previousProperty.title):"Você está no primeiro anúncio"}</small>
      </a>

      <a class="property-sequence-home" href="${escapeHTML(catalogIndexUrl())}">
        <strong>⌂ ${advisorCatalogCode?"Voltar ao catálogo deste assessor":"Voltar ao catálogo completo"}</strong>
        <small>${advisorCatalogCode?"Somente imóveis deste assessor":"Página principal do catálogo"}</small>
      </a>

      <a class="property-sequence-btn next ${nextProperty?"":"disabled"}"
         ${nextProperty?`href="${escapeHTML(propertyDetailUrl(nextProperty.id))}"`:'aria-disabled="true" tabindex="-1"'}>
        <span>Próximo anúncio →</span>
        <small>${nextProperty?escapeHTML(nextProperty.title):"Você chegou ao último anúncio"}</small>
      </a>
    </nav>
  `;

  wireGallery();
}

load();
