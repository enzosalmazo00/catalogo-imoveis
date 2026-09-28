import { db, STORAGE_BUCKET, publicImageUrl } from "./config.js";
import {
  $,
  $$,
  escapeHTML,
  money,
  propertyTypeLabel,
  statusLabel,
  isAdmin,
  slugify
} from "./common.js?v=202609281430";

const state = {
  tab: "dashboard",
  properties: [],
  features: [],
  universities: [],
  owners: [],
  tenants: [],
  rentals: [],
  finances: [],
  management: [],
  settings: null
};

const titles = {
  dashboard: "Visão geral",
  properties: "Imóveis",
  universities: "Faculdades",
  owners: "Proprietários",
  tenants: "Locatários",
  rentals: "Locações",
  finance: "Financeiro",
  settings: "Configurações"
};

function withTimeout(promise,ms=12000,label="Operação"){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" demorou mais que o esperado.")),ms);
  });
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}

function n(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countOptions(value,max=10) {
  return Array.from({length:max+1},(_,i) =>
    `<option value="${i}" ${Number(value ?? 0) === i ? "selected" : ""}>${i}</option>`
  ).join("");
}

function dateBR(value) {
  if (!value) return "—";
  const [y,m,d] = String(value).slice(0,10).split("-");
  return `${d}/${m}/${y}`;
}

function propertyById(id) {
  return state.properties.find(item => item.id === id);
}

function ownerById(id) {
  return state.owners.find(item => item.id === id);
}

function tenantById(id) {
  return state.tenants.find(item => item.id === id);
}

function showModal(html) {
  const layer = $("#adminModal");
  layer.innerHTML = `<div class="modal-card">${html}</div>`;
  layer.classList.remove("hidden");
}

function closeModal() {
  $("#adminModal").classList.add("hidden");
  $("#adminModal").innerHTML = "";
}

function message(text, ok=false) {
  return `<span style="color:${ok ? "#176548" : "#a11824"}">${escapeHTML(text)}</span>`;
}

async function refreshData() {
  const [
    properties,
    features,
    universities,
    owners,
    tenants,
    rentals,
    finances,
    management,
    settings
  ] = await Promise.all([
    db.from("properties").select("*, property_media(*), property_features(feature_id)").order("created_at",{ascending:false}),
    db.from("features").select("*").order("category").order("sort_order"),
    db.from("universities").select("*").order("sort_order").order("name"),
    db.from("owners").select("*").order("name"),
    db.from("tenants").select("*").order("name"),
    db.from("rentals").select("*").order("created_at",{ascending:false}),
    db.from("financial_entries").select("*").order("created_at",{ascending:false}),
    db.from("property_management").select("*"),
    db.from("site_settings").select("*").eq("id",true).maybeSingle()
  ]);

  state.properties = properties.data || [];
  state.features = features.data || [];
  state.universities = universities.data || [];
  state.owners = owners.data || [];
  state.tenants = tenants.data || [];
  state.rentals = rentals.data || [];
  state.finances = finances.data || [];
  state.management = management.data || [];
  state.settings = settings.data || null;
}

function renderDashboard() {
  const available = state.properties.filter(p => p.status === "available").length;
  const rented = state.properties.filter(p => p.status === "rented").length;
  const month = new Date().toISOString().slice(0,7);
  const paidMonth = state.finances
    .filter(f => f.status === "paid" && String(f.paid_date || "").startsWith(month))
    .reduce((sum,f) => sum + Number(f.amount || 0), 0);
  const pending = state.finances
    .filter(f => f.status === "pending")
    .reduce((sum,f) => sum + Number(f.amount || 0), 0);

  $("#adminContent").innerHTML = `
    <div class="dashboard-grid">
      <div class="metric-card"><span>Imóveis disponíveis</span><strong>${available}</strong></div>
      <div class="metric-card"><span>Imóveis alugados</span><strong>${rented}</strong></div>
      <div class="metric-card"><span>Recebido no mês</span><strong>${money(paidMonth)}</strong></div>
      <div class="metric-card"><span>Financeiro pendente</span><strong>${money(pending)}</strong></div>
    </div>

    <section class="admin-panel">
      <div class="admin-panel-head">
        <div><p class="eyebrow">ACESSO RÁPIDO</p><h2>Gestão</h2></div>
        <button class="btn primary" data-action="new-property">+ Novo imóvel</button>
      </div>
      <div class="property-facts">
        <button class="btn ghost" data-goto="properties">Gerenciar imóveis</button>
        <button class="btn ghost" data-goto="finance">Abrir financeiro</button>
        <button class="btn ghost" data-goto="universities">Faculdades</button>
        <button class="btn ghost" data-goto="settings">Configurações do catálogo</button>
      </div>
    </section>

    <section class="admin-panel">
      <div class="admin-panel-head"><h2>Imóveis recentes</h2></div>
      ${propertyTable(state.properties.slice(0,6))}
    </section>
  `;
}

function propertyTable(list) {
  if (!list.length) return '<div class="empty-state"><strong>Nenhum imóvel cadastrado.</strong></div>';
  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Código</th><th>Imóvel</th><th>Tipo</th><th>Valor</th><th>Status</th><th>Publicação</th><th>Ações</th></tr></thead>
        <tbody>
          ${list.map(p => `
            <tr>
              <td><strong class="admin-property-code">${escapeHTML(p.public_code||"—")}</strong></td>
              <td><strong>${escapeHTML(p.title)}</strong><br><span class="muted">${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))}</span></td>
              <td>${escapeHTML(propertyTypeLabel(p.property_type))}</td>
              <td>${money(p.price,p.currency)}</td>
              <td><span class="status-dot ${p.status}">${escapeHTML(statusLabel(p.status))}</span></td>
              <td>${p.is_published ? "Publicado" : "Não publicado"}</td>
              <td>
                <div class="table-actions">
                  <button class="btn ghost compact" data-action="edit-property" data-id="${p.id}">Editar</button>
                  <button class="btn ghost compact" data-action="toggle-status" data-id="${p.id}">${p.status === "rented" ? "Disponível" : "Alugado"}</button>
                  <button class="btn danger compact" data-action="delete-property" data-id="${p.id}">Excluir</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function advisorPropertyGroups(){
  const groups=new Map();

  state.properties.forEach(property=>{
    const key=property.advisor_id || "__admin__";
    if(!groups.has(key)){
      groups.set(key,{
        key,
        advisor_id:property.advisor_id||null,
        advisor_name:property.advisor_id ? (property.advisor_name||"Assessor sem nome") : "Imóveis da administração",
        advisor_company:property.advisor_id ? (property.advisor_company||"") : "Cadastro direto pelo administrador",
        properties:[]
      });
    }
    groups.get(key).properties.push(property);
  });

  return [...groups.values()].sort((a,b)=>{
    if(a.key==="__admin__") return 1;
    if(b.key==="__admin__") return -1;
    return String(a.advisor_name).localeCompare(String(b.advisor_name),"pt-BR");
  });
}

function advisorPropertyGroupCard(group){
  const total=group.properties.length;
  const available=group.properties.filter(p=>p.status==="available").length;
  const rented=group.properties.filter(p=>p.status==="rented").length;
  const published=group.properties.filter(p=>p.is_published).length;

  return `
    <section class="advisor-property-admin-group">
      <div class="advisor-property-admin-head">
        <div>
          <p class="eyebrow">${group.advisor_id?"CORRETOR / ASSESSOR":"ADMINISTRAÇÃO"}</p>
          <h3>${escapeHTML(group.advisor_name)}</h3>
          ${group.advisor_company ? `<span>${escapeHTML(group.advisor_company)}</span>` : ""}
        </div>
        <div class="advisor-property-admin-stats">
          <strong>${total} ${total===1?"imóvel":"imóveis"}</strong>
          <span>${available} disponíveis · ${rented} alugados · ${published} publicados</span>
        </div>
      </div>
      ${propertyTable(group.properties)}
    </section>
  `;
}

function renderProperties() {
  const groups=advisorPropertyGroups();

  $("#adminContent").innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head">
        <div>
          <p class="eyebrow">CATÁLOGO</p>
          <h2>Imóveis por corretor</h2>
          <p class="muted">Cada corretor / assessor aparece em um bloco separado para facilitar a gestão dos anúncios.</p>
        </div>
        <button class="btn primary" data-action="new-property">+ Cadastrar imóvel</button>
      </div>

      <div class="advisor-property-admin-groups">
        ${groups.length
          ? groups.map(advisorPropertyGroupCard).join("")
          : '<div class="empty-state"><strong>Nenhum imóvel cadastrado.</strong></div>'}
      </div>
    </section>
  `;
}

function featureChecks(selected = []) {
  const selectedSet = new Set(selected);
  const furniture = state.features.filter(f => f.category === "furniture");
  const included = state.features.filter(f => f.category === "included");
  const security = state.features.filter(f => f.category === "security");
  const nearby = state.features.filter(f => f.category === "nearby");
  const render = items => items.map(f => `
    <label class="check-chip">
      <input type="checkbox" name="features" value="${f.id}" ${selectedSet.has(f.id) ? "checked" : ""}>
      <span>${escapeHTML(f.name)}</span>
    </label>
  `).join("");

  return {
    furniture: render(furniture),
    included: render(included),
    security: render(security),
    nearby: render(nearby)
  };
}

function propertyModal(property=null) {
  const selected = (property?.property_features || []).map(x => x.feature_id);
  const checks = featureChecks(selected);
  const management = state.management.find(m => m.property_id === property?.id);
  const media = property?.property_media || [];

  showModal(`
    <div class="modal-head">
      <div><p class="eyebrow">IMÓVEL</p><h2>${property ? "Editar imóvel" : "Cadastrar imóvel"}</h2></div>
      <button class="icon-btn" data-action="close-modal" aria-label="Fechar">✕</button>
    </div>

    <form id="propertyForm" class="form-grid">
      <input type="hidden" name="id" value="${property?.id || ""}">

      <label>Título
        <input name="title" required value="${escapeHTML(property?.title || "")}" placeholder="Ex.: Apartamento mobiliado próximo à universidade">
      </label>

      <label>Tipo de imóvel
        <select name="property_type" required>
          ${["apartamento","casa","monoambiente","kitnet","outro"].map(type => `<option value="${type}" ${property?.property_type === type ? "selected" : ""}>${propertyTypeLabel(type)}</option>`).join("")}
        </select>
      </label>

      <label>Moeda
        <select name="currency" required>
          <option value="BRL" ${(property?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${property?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>

      <label>Valor mensal
        <input name="price" type="number" min="0" step="1" required value="${property?.price ?? ""}">
      </label>

      <label>Valor da caução
        <input name="security_deposit" type="number" min="0" step="0.01" value="${property?.security_deposit ?? ""}">
      </label>

      <label>Caução pode ser parcelada?
        <select name="security_deposit_installment_allowed">
          <option value="false" ${!property?.security_deposit_installment_allowed ? "selected" : ""}>Não</option>
          <option value="true" ${property?.security_deposit_installment_allowed ? "selected" : ""}>Sim</option>
        </select>
      </label>

      <label>Máximo de parcelas da caução
        <input name="security_deposit_max_installments" type="number" min="2" max="24" step="1" value="${property?.security_deposit_max_installments ?? ""}" placeholder="Ex.: 3">
      </label>

      <label>Forma de fechamento
        <select name="closing_mode">
          <option value="advisor" ${(!property || property.closing_mode === "advisor") ? "selected" : ""}>Via assessoria</option>
          <option value="direct_owner" ${property?.closing_mode === "direct_owner" ? "selected" : ""}>Direto com o proprietário</option>
        </select>
      </label>

      <label>WhatsApp para contato deste imóvel
        <input name="contact_whatsapp" required inputmode="tel" value="${escapeHTML(property?.contact_whatsapp || "")}" placeholder="Ex.: 595981123456">
      </label>

      <label>Taxa de assessoria
        <select name="has_advisory_fee">
          <option value="false" ${!property?.has_advisory_fee ? "selected" : ""}>Não possui</option>
          <option value="true" ${property?.has_advisory_fee ? "selected" : ""}>Possui</option>
        </select>
      </label>

      <label>Valor da assessoria
        <input name="advisory_fee" type="number" min="0" step="0.01" value="${property?.advisory_fee ?? ""}">
      </label>

      <label>Quartos
        <select name="bedrooms">${countOptions(property?.bedrooms,10)}</select>
      </label>

      <label>Banheiros
        <select name="bathrooms">${countOptions(property?.bathrooms,10)}</select>
      </label>

      <label>Status
        <select name="status">
          <option value="available" ${(!property || property.status === "available") ? "selected" : ""}>Disponível</option>
          <option value="rented" ${property?.status === "rented" ? "selected" : ""}>Alugado</option>
          <option value="hidden" ${property?.status === "hidden" ? "selected" : ""}>Oculto</option>
        </select>
      </label>

      <label>Mobília
        <select name="furnished">
          <option value="false" ${!property?.furnished ? "selected" : ""}>Sem mobília</option>
          <option value="true" ${property?.furnished ? "selected" : ""}>Mobiliado</option>
        </select>
      </label>

      <div class="form-section-title">Ficha técnica</div>

      <label>Contexto do imóvel
        <select name="housing_context">
          <option value="independent" ${property?.housing_context!=="condominium"?"selected":""}>Independente</option>
          <option value="condominium" ${property?.housing_context==="condominium"?"selected":""}>Em condomínio</option>
        </select>
      </label>

      <label>Nome do condomínio
        <input name="condominium_name" value="${escapeHTML(property?.condominium_name||"")}" placeholder="Se houver">
      </label>

      <label>Imóvel de fundo?
        <select name="is_rear_unit"><option value="false" ${!property?.is_rear_unit?"selected":""}>Não</option><option value="true" ${property?.is_rear_unit?"selected":""}>Sim</option></select>
      </label>

      <label>Escada para acesso?
        <select name="has_stairs_access"><option value="false" ${!property?.has_stairs_access?"selected":""}>Não</option><option value="true" ${property?.has_stairs_access?"selected":""}>Sim</option></select>
      </label>

      <label>Quantidade de cômodos
        <input name="room_count" type="number" min="1" step="1" value="${property?.room_count??""}" placeholder="Não se aplica a monoambiente">
      </label>

      <label>Sala?
        <select name="has_living_room"><option value="false" ${!property?.has_living_room?"selected":""}>Não</option><option value="true" ${property?.has_living_room?"selected":""}>Sim</option></select>
      </label>

      <label>Cozinha?
        <select name="has_kitchen"><option value="false" ${!property?.has_kitchen?"selected":""}>Não</option><option value="true" ${property?.has_kitchen?"selected":""}>Sim</option></select>
      </label>

      <label>Lavanderia
        <select name="laundry_type">
          <option value="none" ${(property?.laundry_type||"none")==="none"?"selected":""}>Não possui</option>
          <option value="private" ${property?.laundry_type==="private"?"selected":""}>Privativa</option>
          <option value="shared" ${property?.laundry_type==="shared"?"selected":""}>Compartilhada</option>
        </select>
      </label>

      <label>Garagem
        <select name="garage_scope">
          <option value="none" ${(property?.garage_scope||"none")==="none"?"selected":""}>Não possui</option>
          <option value="shared" ${property?.garage_scope==="shared"?"selected":""}>Coletiva / compartilhada</option>
          <option value="private" ${property?.garage_scope==="private"?"selected":""}>Própria / privativa</option>
        </select>
      </label>

      <label>Garagem para
        <select name="garage_vehicle">
          <option value="none" ${(property?.garage_vehicle||"none")==="none"?"selected":""}>Não informar</option>
          <option value="car_motorcycle" ${property?.garage_vehicle==="car_motorcycle"?"selected":""}>Carro e moto</option>
          <option value="car" ${property?.garage_vehicle==="car"?"selected":""}>Somente carro</option>
          <option value="motorcycle" ${property?.garage_vehicle==="motorcycle"?"selected":""}>Somente moto</option>
        </select>
      </label>

      <label>Portão eletrônico?
        <select name="has_electronic_gate"><option value="false" ${!property?.has_electronic_gate?"selected":""}>Não</option><option value="true" ${property?.has_electronic_gate?"selected":""}>Sim</option></select>
      </label>

      <div class="form-section-title">Localização</div>

      <label class="span-2 maps-link-field">Link do imóvel no Google Maps
        <input name="google_maps_url" type="url" value="${escapeHTML(property?.google_maps_url || "")}" placeholder="Cole aqui o link compartilhado do Google Maps">
        <small>Google Maps → Compartilhar → Copiar link. Latitude e longitude são obtidas automaticamente quando possível.</small>
      </label>

      <label>Bairro
        <input name="neighborhood" value="${escapeHTML(property?.neighborhood || "")}">
      </label>

      <label>Cidade do imóvel
        <select name="city" required>
          <option value="">Selecione a cidade</option>
          <option value="Pedro Juan Caballero" ${property?.city === "Pedro Juan Caballero" ? "selected" : ""}>Pedro Juan Caballero</option>
          <option value="Ponta Porã" ${property?.city === "Ponta Porã" ? "selected" : ""}>Ponta Porã</option>
        </select>
      </label>

      <label class="span-2">Endereço escrito (opcional)
        <input name="address" value="${escapeHTML(property?.address || "")}" placeholder="Rua, número, bairro, cidade">
      </label>

      <label>
        Exibir localização
        <select name="show_exact_location">
          <option value="false" ${!property?.show_exact_location ? "selected" : ""}>Apenas região aproximada</option>
          <option value="true" ${property?.show_exact_location ? "selected" : ""}>Localização exata</option>
        </select>
      </label>

      <div></div>

      <label>
        Proprietário
        <select name="owner_id">
          <option value="">Não vinculado</option>
          ${state.owners.map(o => `<option value="${o.id}" ${management?.owner_id === o.id ? "selected" : ""}>${escapeHTML(o.name)}</option>`).join("")}
        </select>
      </label>

      <label>
        Publicar no catálogo?
        <select name="is_published">
          <option value="true" ${property?.is_published !== false ? "selected" : ""}>Sim</option>
          <option value="false" ${property?.is_published === false ? "selected" : ""}>Não</option>
        </select>
      </label>

      <label>
        Imóvel em destaque?
        <select name="featured">
          <option value="false" ${!property?.featured ? "selected" : ""}>Não</option>
          <option value="true" ${property?.featured ? "selected" : ""}>Sim</option>
        </select>
      </label>

      <label class="span-2">Descrição
        <textarea name="description" placeholder="Descreva o imóvel, condições e diferenciais.">${escapeHTML(property?.description || "")}</textarea>
      </label>

      <div class="form-section-title">Mobília e estrutura</div>
      <div class="span-2 checkbox-row">${checks.furniture}</div>

      <div class="form-section-title">Segurança</div>
      <div class="span-2 checkbox-row">${checks.security}</div>

      <div class="form-section-title">Comodidades próximas</div>
      <div class="span-2 checkbox-row">${checks.nearby}</div>

      <div class="form-section-title">Itens inclusos no aluguel</div>
      <div class="span-2 checkbox-row">${checks.included}</div>

      <div class="form-section-title">Fotos e vídeo</div>
      <label class="span-2">Adicionar fotos
        <input name="images" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple>
      </label>

      <label class="span-2">Link de vídeo do YouTube
        <input name="youtube" type="url" placeholder="https://youtube.com/watch?v=...">
      </label>

      ${media.length ? `
        <div class="span-2 media-admin-grid">
          ${media.map(m => m.media_type === "image" ? `
            <div class="media-admin-item">
              <img src="${escapeHTML(publicImageUrl(m.storage_path))}" alt="">
              <div class="media-actions">
                <button type="button" data-action="cover-media" data-id="${m.id}" data-property="${property.id}">${m.is_cover ? "Capa ✓" : "Definir capa"}</button>
                <button type="button" data-action="delete-media" data-id="${m.id}">Excluir</button>
              </div>
            </div>
          ` : `
            <div class="media-admin-item">
              <div style="height:120px;display:grid;place-items:center;background:#101820;color:#fff">YouTube</div>
              <div class="media-actions"><button type="button" data-action="delete-media" data-id="${m.id}">Excluir vídeo</button></div>
            </div>
          `).join("")}
        </div>
      ` : ""}

      <label class="span-2">Observações internas
        <textarea name="internal_notes" placeholder="Só você verá estas observações.">${escapeHTML(management?.internal_notes || "")}</textarea>
      </label>

      <div class="form-actions">
        <button class="btn ghost" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn primary" type="submit">Salvar imóvel</button>
      </div>
      <div id="propertyFormMessage" class="span-2 form-message"></div>
    </form>
  `);
}

async function saveProperty(form) {
  const fd = new FormData(form);
  const id = fd.get("id") || null;
  const current = propertyById(id);

  const title = String(fd.get("title") || "").trim();
  if (!title) return;

  const googleMapsUrl = String(fd.get("google_maps_url") || "").trim() || null;
  let latitude = current?.latitude ?? null;
  let longitude = current?.longitude ?? null;

  const msg = $("#propertyFormMessage");
  msg.innerHTML = message("Salvando...", true);

  if (googleMapsUrl) {
    msg.innerHTML = message("Lendo o link do Google Maps...", true);
    const resolved = await db.functions.invoke("resolve-maps-link", { body: { url: googleMapsUrl } });
    if (resolved.error || resolved.data?.error) {
      msg.innerHTML = message(resolved.data?.error || resolved.error?.message || "Não foi possível ler o link do Google Maps.");
      return;
    }
    if (resolved.data?.latitude != null && resolved.data?.longitude != null) {
      latitude = Number(resolved.data.latitude);
      longitude = Number(resolved.data.longitude);
    }
  } else if (current?.google_maps_url) {
    latitude = null;
    longitude = null;
  }

  const row = {
    title,
    slug: current?.slug || `${slugify(title)}-${Date.now().toString(36)}`,
    property_type: fd.get("property_type"),
    description: String(fd.get("description") || "").trim() || null,
    price: n(fd.get("price")),
    currency:fd.get("currency")||"BRL",
    security_deposit: n(fd.get("security_deposit")),
    security_deposit_installment_allowed: fd.get("security_deposit_installment_allowed") === "true",
    security_deposit_max_installments: fd.get("security_deposit_installment_allowed") === "true" ? n(fd.get("security_deposit_max_installments")) : null,
    closing_mode: fd.get("closing_mode") || "advisor",
    contact_whatsapp: String(fd.get("contact_whatsapp") || "").replace(/\D/g, "") || null,
    has_advisory_fee: fd.get("has_advisory_fee") === "true",
    advisory_fee: fd.get("has_advisory_fee") === "true" ? n(fd.get("advisory_fee")) : null,
    address: String(fd.get("address") || "").trim() || null,
    neighborhood: String(fd.get("neighborhood") || "").trim() || null,
    city: String(fd.get("city") || "").trim() || null,
    google_maps_url: googleMapsUrl,
    latitude,
    longitude,
    show_exact_location: fd.get("show_exact_location") === "true",
    bedrooms: n(fd.get("bedrooms")),
    bathrooms: n(fd.get("bathrooms")),
    furnished: fd.get("furnished") === "true",
    housing_context:fd.get("housing_context")||"independent",
    condominium_name:fd.get("housing_context")==="condominium" ? String(fd.get("condominium_name")||"").trim()||null : null,
    is_rear_unit:fd.get("is_rear_unit")==="true",
    has_stairs_access:fd.get("has_stairs_access")==="true",
    room_count:fd.get("property_type")==="monoambiente" ? null : n(fd.get("room_count")),
    has_living_room:fd.get("property_type")==="monoambiente" ? false : fd.get("has_living_room")==="true",
    has_kitchen:fd.get("property_type")==="monoambiente" ? false : fd.get("has_kitchen")==="true",
    laundry_type:fd.get("laundry_type")||"none",
    garage_scope:fd.get("garage_scope")||"none",
    garage_vehicle:fd.get("garage_scope")==="none" ? "none" : (fd.get("garage_vehicle")||"none"),
    has_electronic_gate:fd.get("garage_scope")==="none" ? false : fd.get("has_electronic_gate")==="true",
    status: fd.get("status"),
    is_published: fd.get("is_published") === "true",
    featured: fd.get("featured") === "true"
  };

  msg.innerHTML = message("Salvando...", true);

  let propertyId = id;
  if (id) {
    const { error } = await db.from("properties").update(row).eq("id", id);
    if (error) {
      msg.innerHTML = message(error.message);
      return;
    }
  } else {
    const { data, error } = await db.from("properties").insert(row).select("id").single();
    if (error) {
      msg.innerHTML = message(error.message);
      return;
    }
    propertyId = data.id;
  }

  const featureIds = [...form.querySelectorAll('input[name="features"]:checked')].map(el => el.value);
  await db.from("property_features").delete().eq("property_id", propertyId);
  if (featureIds.length) {
    const { error } = await db.from("property_features").insert(
      featureIds.map(feature_id => ({ property_id: propertyId, feature_id }))
    );
    if (error) {
      msg.innerHTML = message(error.message);
      return;
    }
  }

  const ownerId = fd.get("owner_id") || null;
  const internalNotes = String(fd.get("internal_notes") || "").trim() || null;
  if (ownerId || internalNotes) {
    const { error } = await db.from("property_management").upsert({
      property_id: propertyId,
      owner_id: ownerId,
      internal_notes: internalNotes
    });
    if (error) {
      msg.innerHTML = message(error.message);
      return;
    }
  } else {
    await db.from("property_management").delete().eq("property_id", propertyId);
  }

  const files = [...form.querySelector('input[name="images"]').files];
  const existingImages = current?.property_media?.filter(m => m.media_type === "image") || [];
  let firstNew = existingImages.length === 0;

  for (const file of files) {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `${propertyId}/${crypto.randomUUID()}-${safe}`;
    const upload = await db.storage.from(STORAGE_BUCKET).upload(path, file, {
      cacheControl: "3600",
      upsert: false
    });
    if (upload.error) {
      msg.innerHTML = message(`Erro no upload: ${upload.error.message}`);
      return;
    }
    const insert = await db.from("property_media").insert({
      property_id: propertyId,
      media_type: "image",
      storage_path: path,
      is_cover: firstNew,
      sort_order: (existingImages.length + files.indexOf(file)) * 10
    });
    if (insert.error) {
      msg.innerHTML = message(insert.error.message);
      return;
    }
    firstNew = false;
  }

  const youtube = String(fd.get("youtube") || "").trim();
  if (youtube) {
    const { error } = await db.from("property_media").insert({
      property_id: propertyId,
      media_type: "youtube",
      external_url: youtube,
      sort_order: 999
    });
    if (error) {
      msg.innerHTML = message(error.message);
      return;
    }
  }

  await refreshData();
  closeModal();
  renderCurrent();
}

async function deleteProperty(id) {
  const property = propertyById(id);
  if (!property || !confirm(`Excluir definitivamente "${property.title}"?\n\nO imóvel e seus dados vinculados serão removidos.`)) return;

  const paths = (property.property_media || [])
    .filter(m => m.media_type === "image" && m.storage_path)
    .map(m => m.storage_path);

  if (paths.length) await db.storage.from(STORAGE_BUCKET).remove(paths);

  const { error } = await db.from("properties").delete().eq("id", id);
  if (error) {
    alert(error.message);
    return;
  }
  await refreshData();
  renderCurrent();
}

async function togglePropertyStatus(id) {
  const property = propertyById(id);
  if (!property) return;
  const next = property.status === "rented" ? "available" : "rented";
  const { error } = await db.from("properties").update({ status: next }).eq("id", id);
  if (error) return alert(error.message);
  await refreshData();
  renderCurrent();
}

async function deleteMedia(id) {
  const { data: media } = await db.from("property_media").select("*").eq("id",id).maybeSingle();
  if (!media || !confirm("Excluir esta mídia?")) return;
  if (media.media_type === "image" && media.storage_path) {
    await db.storage.from(STORAGE_BUCKET).remove([media.storage_path]);
  }
  await db.from("property_media").delete().eq("id",id);
  await refreshData();
  propertyModal(propertyById(media.property_id));
}

async function setCover(mediaId, propertyId) {
  await db.from("property_media").update({ is_cover:false }).eq("property_id", propertyId).eq("media_type","image");
  const { error } = await db.from("property_media").update({ is_cover:true }).eq("id",mediaId);
  if (error) return alert(error.message);
  await refreshData();
  propertyModal(propertyById(propertyId));
}

function simpleTable(kind, rows, columns) {
  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>${columns.map(c => `<th>${escapeHTML(c.label)}</th>`).join("")}<th>Ações</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(row => `
            <tr>
              ${columns.map(c => `<td>${c.render ? c.render(row) : escapeHTML(row[c.key] ?? "—")}</td>`).join("")}
              <td><div class="table-actions">
                <button class="btn ghost compact" data-action="edit-${kind}" data-id="${row.id}">Editar</button>
                <button class="btn danger compact" data-action="delete-${kind}" data-id="${row.id}">Excluir</button>
              </div></td>
            </tr>
          `).join("") : `<tr><td colspan="${columns.length+1}" class="muted">Nenhum registro.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderUniversities() {
  $("#adminContent").innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head">
      <div><p class="eyebrow">REFERÊNCIAS</p><h2>Faculdades / Universidades</h2></div>
      <div class="table-actions">
        <button class="btn ghost" data-action="revalidate-universities">Revalidar pinos</button>
        <button class="btn primary" data-action="new-university">+ Nova faculdade</button>
      </div>
    </div>
      ${simpleTable("university",state.universities,[
        {label:"Nome",key:"name"},
        {label:"Endereço",key:"address"},
        {label:"Ativa",render:r=>r.active?"Sim":"Não"}
      ])}
      <p class="tiny-note">As distâncias reais de carro e a pé serão calculadas pela integração de rotas do Google quando a chave da API for configurada.</p>
    </section>
  `;
}

function universityModal(row=null) {
  showModal(`
    <div class="modal-head"><div><p class="eyebrow">UNIVERSIDADE</p><h2>${row?"Editar":"Cadastrar"} universidade</h2></div><button class="icon-btn" data-action="close-modal">✕</button></div>
    <form id="universityForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label>Nome<input name="name" required value="${escapeHTML(row?.name||"")}"></label>
      <label>Ativa?<select name="active"><option value="true" ${row?.active!==false?"selected":""}>Sim</option><option value="false" ${row?.active===false?"selected":""}>Não</option></select></label>
      <label class="span-2">Endereço<input name="address" required value="${escapeHTML(row?.address||"")}" placeholder="Endereço da faculdade"></label>
      <label class="span-2">Link exato no Google Maps
        <input name="google_maps_url" type="url" required value="${escapeHTML(row?.google_maps_url||"")}" placeholder="Google Maps → Compartilhar → Copiar link">
        <small>Use o link compartilhado a partir do pino/ficha exata da faculdade. Links que retornarem apenas o centro aproximado do mapa serão recusados.</small>
      </label>
      ${row?.latitude!=null&&row?.longitude!=null?`<div class="span-2 tiny-note">Localização registrada: ${row.latitude}, ${row.longitude}</div>`:""}
      <div id="universitySaveMessage" class="form-message span-2" aria-live="polite"></div>
      <div class="form-actions"><button class="btn ghost" type="button" data-action="close-modal">Cancelar</button><button class="btn primary" type="button" data-action="save-university">Salvar</button></div>
    </form>
  `);
}

function personModal(kind,row=null) {
  const title = kind === "owner" ? "proprietário" : "locatário";
  showModal(`
    <div class="modal-head"><div><p class="eyebrow">${title.toUpperCase()}</p><h2>${row?"Editar":"Cadastrar"} ${title}</h2></div><button class="icon-btn" data-action="close-modal">✕</button></div>
    <form id="personForm" data-kind="${kind}" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label>Nome<input name="name" required value="${escapeHTML(row?.name||"")}"></label>
      <label>Telefone<input name="phone" value="${escapeHTML(row?.phone||"")}"></label>
      <label>E-mail<input name="email" type="email" value="${escapeHTML(row?.email||"")}"></label>
      <label>Documento<input name="document" value="${escapeHTML(row?.document||"")}"></label>
      <label class="span-2">Observações<textarea name="notes">${escapeHTML(row?.notes||"")}</textarea></label>
      <div class="form-actions"><button class="btn ghost" type="button" data-action="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
    </form>
  `);
}

function renderOwners() {
  $("#adminContent").innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head"><div><p class="eyebrow">CADASTROS</p><h2>Proprietários</h2></div><button class="btn primary" data-action="new-owner">+ Novo proprietário</button></div>
      ${simpleTable("owner",state.owners,[
        {label:"Nome",key:"name"},{label:"Telefone",key:"phone"},{label:"E-mail",key:"email"}
      ])}
    </section>
  `;
}

function renderTenants() {
  $("#adminContent").innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head"><div><p class="eyebrow">CADASTROS</p><h2>Locatários</h2></div><button class="btn primary" data-action="new-tenant">+ Novo locatário</button></div>
      ${simpleTable("tenant",state.tenants,[
        {label:"Nome",key:"name"},{label:"Telefone",key:"phone"},{label:"E-mail",key:"email"}
      ])}
    </section>
  `;
}

function rentalTable() {
  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Imóvel</th><th>Locatário</th><th>Proprietário</th><th>Valor alugado</th><th>Período</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>
          ${state.rentals.length ? state.rentals.map(r => `
            <tr>
              <td>${escapeHTML(propertyById(r.property_id)?.title || "—")}</td>
              <td>${escapeHTML(tenantById(r.tenant_id)?.name || "—")}</td>
              <td>${escapeHTML(ownerById(r.owner_id)?.name || "—")}</td>
              <td>${r.rented_value != null ? money(r.rented_value) : "—"}</td>
              <td>${dateBR(r.start_date)} → ${dateBR(r.end_date)}</td>
              <td><span class="pill">${escapeHTML(r.status)}</span></td>
              <td><div class="table-actions"><button class="btn ghost compact" data-action="edit-rental" data-id="${r.id}">Editar</button><button class="btn danger compact" data-action="delete-rental" data-id="${r.id}">Excluir</button></div></td>
            </tr>
          `).join("") : '<tr><td colspan="7" class="muted">Nenhuma locação registrada.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function renderRentals() {
  $("#adminContent").innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head"><div><p class="eyebrow">CONTROLE MANUAL</p><h2>Locações</h2></div><button class="btn primary" data-action="new-rental">+ Registrar locação</button></div>
      <p class="muted">Registrar ou editar uma locação não altera automaticamente o status do imóvel. Você controla o status em Imóveis.</p>
      ${rentalTable()}
    </section>
  `;
}

function rentalModal(row=null) {
  showModal(`
    <div class="modal-head"><div><p class="eyebrow">LOCAÇÃO</p><h2>${row?"Editar":"Registrar"} locação</h2></div><button class="icon-btn" data-action="close-modal">✕</button></div>
    <form id="rentalForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label>Imóvel<select name="property_id" required><option value="">Selecione</option>${state.properties.map(p=>`<option value="${p.id}" ${row?.property_id===p.id?"selected":""}>${escapeHTML(p.title)}</option>`).join("")}</select></label>
      <label>Locatário<select name="tenant_id"><option value="">Não informado</option>${state.tenants.map(t=>`<option value="${t.id}" ${row?.tenant_id===t.id?"selected":""}>${escapeHTML(t.name)}</option>`).join("")}</select></label>
      <label>Proprietário<select name="owner_id"><option value="">Não informado</option>${state.owners.map(o=>`<option value="${o.id}" ${row?.owner_id===o.id?"selected":""}>${escapeHTML(o.name)}</option>`).join("")}</select></label>
      <label>Status<select name="status"><option value="active" ${row?.status==="active"||!row?"selected":""}>Ativa</option><option value="ended" ${row?.status==="ended"?"selected":""}>Encerrada</option><option value="cancelled" ${row?.status==="cancelled"?"selected":""}>Cancelada</option></select></label>
      <label>Data de início<input name="start_date" type="date" value="${row?.start_date||""}"></label>
      <label>Data de término<input name="end_date" type="date" value="${row?.end_date||""}"></label>
      <label>Valor alugado<input name="rented_value" type="number" min="0" step="0.01" value="${row?.rented_value??""}"></label>
      <label>Valor da caução<input name="security_deposit" type="number" min="0" step="0.01" value="${row?.security_deposit??""}"></label>
      <label>Taxa de assessoria<input name="advisory_fee" type="number" min="0" step="0.01" value="${row?.advisory_fee??""}"></label>
      <label>Comissão paga pelo proprietário<input name="owner_commission" type="number" min="0" step="0.01" value="${row?.owner_commission??""}"></label>
      <label>Comissão foi paga?<select name="owner_commission_paid"><option value="false" ${!row?.owner_commission_paid?"selected":""}>Não</option><option value="true" ${row?.owner_commission_paid?"selected":""}>Sim</option></select></label>
      <label>Data do pagamento da comissão<input name="owner_commission_paid_at" type="date" value="${row?.owner_commission_paid_at||""}"></label>
      <label class="span-2">Observações<textarea name="notes">${escapeHTML(row?.notes||"")}</textarea></label>
      <div class="form-actions"><button class="btn ghost" type="button" data-action="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
    </form>
  `);
}

function renderFinance() {
  const paid = state.finances.filter(f=>f.status==="paid").reduce((s,f)=>s+Number(f.amount||0),0);
  const pending = state.finances.filter(f=>f.status==="pending").reduce((s,f)=>s+Number(f.amount||0),0);
  const commissions = state.finances.filter(f=>f.entry_type==="comissao"&&f.status==="paid").reduce((s,f)=>s+Number(f.amount||0),0);
  const advisory = state.finances.filter(f=>f.entry_type==="assessoria"&&f.status==="paid").reduce((s,f)=>s+Number(f.amount||0),0);

  $("#adminContent").innerHTML = `
    <div class="finance-summary">
      <div class="metric-card"><span>Total recebido</span><strong>${money(paid)}</strong></div>
      <div class="metric-card"><span>Pendente</span><strong>${money(pending)}</strong></div>
      <div class="metric-card"><span>Comissões recebidas</span><strong>${money(commissions)}</strong></div>
      <div class="metric-card"><span>Assessoria recebida</span><strong>${money(advisory)}</strong></div>
    </div>
    <section class="admin-panel">
      <div class="admin-panel-head"><div><p class="eyebrow">CONTROLE MANUAL</p><h2>Lançamentos financeiros</h2></div><button class="btn primary" data-action="new-finance">+ Novo lançamento</button></div>
      <div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>Descrição</th><th>Tipo</th><th>Imóvel</th><th>Valor</th><th>Vencimento</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>${state.finances.length ? state.finances.map(f=>`
          <tr>
            <td>${escapeHTML(f.description||"—")}</td>
            <td>${escapeHTML(f.entry_type)}</td>
            <td>${escapeHTML(propertyById(f.property_id)?.title||"—")}</td>
            <td>${money(f.amount)}</td>
            <td>${dateBR(f.due_date)}</td>
            <td><span class="pill ${f.status}">${escapeHTML(f.status)}</span></td>
            <td><div class="table-actions"><button class="btn ghost compact" data-action="edit-finance" data-id="${f.id}">Editar</button><button class="btn danger compact" data-action="delete-finance" data-id="${f.id}">Excluir</button></div></td>
          </tr>
        `).join("") : '<tr><td colspan="7" class="muted">Nenhum lançamento.</td></tr>'}</tbody>
      </table></div>
    </section>
  `;
}

function financeModal(row=null) {
  showModal(`
    <div class="modal-head"><div><p class="eyebrow">FINANCEIRO</p><h2>${row?"Editar":"Novo"} lançamento</h2></div><button class="icon-btn" data-action="close-modal">✕</button></div>
    <form id="financeForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label>Tipo<select name="entry_type">
        ${["aluguel","caucao","assessoria","comissao","despesa","outra_receita"].map(v=>`<option value="${v}" ${row?.entry_type===v?"selected":""}>${v}</option>`).join("")}
      </select></label>
      <label>Valor<input name="amount" type="number" min="0" step="0.01" required value="${row?.amount??""}"></label>
      <label>Imóvel<select name="property_id"><option value="">Não vinculado</option>${state.properties.map(p=>`<option value="${p.id}" ${row?.property_id===p.id?"selected":""}>${escapeHTML(p.title)}</option>`).join("")}</select></label>
      <label>Locação<select name="rental_id"><option value="">Não vinculada</option>${state.rentals.map(r=>`<option value="${r.id}" ${row?.rental_id===r.id?"selected":""}>${escapeHTML(propertyById(r.property_id)?.title||"Locação")}</option>`).join("")}</select></label>
      <label>Vencimento<input name="due_date" type="date" value="${row?.due_date||""}"></label>
      <label>Data de pagamento<input name="paid_date" type="date" value="${row?.paid_date||""}"></label>
      <label>Status<select name="status"><option value="pending" ${row?.status==="pending"||!row?"selected":""}>Pendente</option><option value="paid" ${row?.status==="paid"?"selected":""}>Pago</option><option value="cancelled" ${row?.status==="cancelled"?"selected":""}>Cancelado</option></select></label>
      <label class="span-2">Descrição<input name="description" value="${escapeHTML(row?.description||"")}"></label>
      <label class="span-2">Observações<textarea name="notes">${escapeHTML(row?.notes||"")}</textarea></label>
      <div class="form-actions"><button class="btn ghost" type="button" data-action="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
    </form>
  `);
}

function renderSettings() {
  const s = state.settings || {};
  $("#adminContent").innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head"><div><p class="eyebrow">CATÁLOGO</p><h2>Configurações públicas</h2></div></div>
      <form id="settingsForm" class="form-grid">
        <label>Nome do site<input name="site_name" required value="${escapeHTML(s.site_name||"")}"></label>
        <label>Número do WhatsApp<input name="whatsapp_number" value="${escapeHTML(s.whatsapp_number||"")}" placeholder="595... ou 55..."></label>
        <label class="span-2">Título principal<input name="hero_title" value="${escapeHTML(s.hero_title||"")}"></label>
        <label class="span-2">Subtítulo<input name="hero_subtitle" value="${escapeHTML(s.hero_subtitle||"")}"></label>
        <div class="form-actions"><button class="btn primary" type="submit">Salvar configurações</button></div>
        <div id="settingsMessage" class="span-2"></div>
      </form>
    </section>
  `;
}

function renderCurrent() {
  $("#adminTitle").textContent = titles[state.tab] || "Administração";
  $$(".nav-btn").forEach(btn => btn.classList.toggle("active",btn.dataset.tab===state.tab));
  ({
    dashboard: renderDashboard,
    properties: renderProperties,
    universities: renderUniversities,
    owners: renderOwners,
    tenants: renderTenants,
    rentals: renderRentals,
    finance: renderFinance,
    settings: renderSettings
  })[state.tab]();
}

async function revalidateUniversityLocations(button=null){
  const rows=state.universities.filter(u=>u.google_maps_url);
  if(!rows.length){
    alert("Nenhuma faculdade com link do Google Maps para revalidar.");
    return;
  }

  const originalText=button?.textContent||"Revalidar pinos";
  if(button){
    button.disabled=true;
    button.textContent="Revalidando...";
  }

  let updated=0;
  const failures=[];

  try{
    for(const uni of rows){
      try{
        const resolved=await withTimeout(
          db.functions.invoke("resolve-maps-link",{body:{url:uni.google_maps_url}}),
          12000,
          "Validação de "+uni.name
        );

        if(resolved.error || resolved.data?.error){
          failures.push(uni.name);
          continue;
        }

        if(resolved.data?.precision!=="exact" || resolved.data?.latitude==null || resolved.data?.longitude==null){
          failures.push(uni.name);
          continue;
        }

        const result=await db.from("universities").update({
          latitude:Number(resolved.data.latitude),
          longitude:Number(resolved.data.longitude)
        }).eq("id",uni.id);

        if(result.error) failures.push(uni.name);
        else updated++;
      }catch(err){
        console.warn("Falha ao revalidar",uni.name,err);
        failures.push(uni.name);
      }
    }

    await refreshData();
    renderCurrent();

    const extra=failures.length
      ? `\n\nPrecisa de novo link apenas para: ${failures.join(", ")}.`
      : "";
    alert(`${updated} faculdade(s) revalidada(s) com pino exato.${extra}`);
  }finally{
    if(button && document.body.contains(button)){
      button.disabled=false;
      button.textContent=originalText;
    }
  }
}

async function saveUniversity(form){
  const msg=form.querySelector("#universitySaveMessage");
  const saveBtn=form.querySelector('[data-action="save-university"]');
  const originalText=saveBtn?.textContent||"Salvar";

  if(!form.checkValidity()){
    const invalid=form.querySelector(":invalid");
    if(msg) msg.textContent="Revise os campos obrigatórios antes de salvar.";
    invalid?.reportValidity();
    return false;
  }

  const fd=new FormData(form);
  const id=fd.get("id")||null;
  const mapsUrl=String(fd.get("google_maps_url")||"").trim();

  if(!mapsUrl){
    if(msg) msg.textContent="Informe o link exato da faculdade no Google Maps.";
    return false;
  }

  if(saveBtn){
    saveBtn.disabled=true;
    saveBtn.textContent="Lendo localização...";
  }
  if(msg) msg.textContent="Obtendo a localização exata pelo Google Maps...";

  try{
    const resolved=await withTimeout(
      db.functions.invoke("resolve-maps-link",{body:{url:mapsUrl}}),
      12000,
      "Leitura do Google Maps"
    );

    if(resolved.error || resolved.data?.error){
      throw new Error(resolved.data?.error || resolved.error?.message || "Não foi possível ler o link do Google Maps.");
    }

    if(resolved.data?.latitude==null || resolved.data?.longitude==null){
      throw new Error("O link não retornou coordenadas. Abra a ficha exata da faculdade no Google Maps, toque em Compartilhar e copie o link novamente.");
    }

    if(resolved.data?.precision!=="exact"){
      throw new Error("Esse link retornou apenas o centro aproximado do mapa. Abra a ficha da faculdade no Google Maps, selecione exatamente o local/pino da faculdade e use Compartilhar → Copiar link.");
    }

    if(saveBtn) saveBtn.textContent="Salvando...";
    if(msg) msg.textContent="Pino exato encontrado. Salvando faculdade...";

    const row={
      name:String(fd.get("name")||"").trim(),
      address:String(fd.get("address")||"").trim(),
      google_maps_url:mapsUrl,
      latitude:Number(resolved.data.latitude),
      longitude:Number(resolved.data.longitude),
      active:fd.get("active")==="true"
    };

    const result=id
      ? await withTimeout(db.from("universities").update(row).eq("id",id),10000,"Salvamento da faculdade")
      : await withTimeout(db.from("universities").insert(row),10000,"Salvamento da faculdade");

    if(result.error) throw result.error;

    if(msg) msg.textContent="Faculdade salva com sucesso ✓";
    if(saveBtn) saveBtn.textContent="Salvo ✓";

    await refreshData();
    renderCurrent();
    setTimeout(()=>closeModal(),350);
    return true;
  }catch(err){
    console.error("Erro ao salvar faculdade:",err);
    if(msg) msg.textContent=err?.message || "Não foi possível salvar a faculdade.";
    if(saveBtn){
      saveBtn.disabled=false;
      saveBtn.textContent=originalText;
    }
    return false;
  }
}

async function saveSimple(form, table, transform) {
  const fd = new FormData(form);
  const id = fd.get("id") || null;
  const row = transform(fd);
  const result = id
    ? await db.from(table).update(row).eq("id",id)
    : await db.from(table).insert(row);
  if (result.error) return alert(result.error.message);
  await refreshData();
  closeModal();
  renderCurrent();
}

async function deleteSimple(table,id,label) {
  if (!confirm(`Excluir ${label}?`)) return;
  const {error}=await db.from(table).delete().eq("id",id);
  if(error) return alert(error.message);
  await refreshData();
  renderCurrent();
}

$("#adminNav").addEventListener("click",event=>{
  const button=event.target.closest("[data-tab]");
  if(!button)return;
  state.tab=button.dataset.tab;
  renderCurrent();
});

$("#adminContent").addEventListener("click",async event=>{
  const goto=event.target.closest("[data-goto]");
  if(goto){state.tab=goto.dataset.goto;renderCurrent();return;}

  const button=event.target.closest("[data-action]");
  if(!button)return;
  const action=button.dataset.action,id=button.dataset.id;

  if(action==="new-property") propertyModal();
  if(action==="edit-property") propertyModal(propertyById(id));
  if(action==="toggle-status") await togglePropertyStatus(id);
  if(action==="delete-property") await deleteProperty(id);

  if(action==="new-university") universityModal();
  if(action==="revalidate-universities") await revalidateUniversityLocations(event.target.closest('[data-action="revalidate-universities"]'));
  if(action==="edit-university") universityModal(state.universities.find(x=>x.id===id));
  if(action==="delete-university") await deleteSimple("universities",id,"esta universidade");

  if(action==="new-owner") personModal("owner");
  if(action==="edit-owner") personModal("owner",ownerById(id));
  if(action==="delete-owner") await deleteSimple("owners",id,"este proprietário");

  if(action==="new-tenant") personModal("tenant");
  if(action==="edit-tenant") personModal("tenant",tenantById(id));
  if(action==="delete-tenant") await deleteSimple("tenants",id,"este locatário");

  if(action==="new-rental") rentalModal();
  if(action==="edit-rental") rentalModal(state.rentals.find(x=>x.id===id));
  if(action==="delete-rental") await deleteSimple("rentals",id,"esta locação");

  if(action==="new-finance") financeModal();
  if(action==="edit-finance") financeModal(state.finances.find(x=>x.id===id));
  if(action==="delete-finance") await deleteSimple("financial_entries",id,"este lançamento");
});

$("#adminModal").addEventListener("click",async event=>{
  if(event.target.id==="adminModal"){closeModal();return;}
  const button=event.target.closest("[data-action]");
  if(!button)return;
  const action=button.dataset.action;
  if(action==="close-modal") closeModal();
  if(action==="save-university"){
    const form=$("#universityForm");
    if(form) await saveUniversity(form);
  }
  if(action==="delete-media") await deleteMedia(button.dataset.id);
  if(action==="cover-media") await setCover(button.dataset.id,button.dataset.property);
});

$("#adminModal").addEventListener("submit",async event=>{
  event.preventDefault();
  const form=event.target;

  if(form.id==="propertyForm"){
    await saveProperty(form);
  }

  if(form.id==="universityForm"){
    await saveUniversity(form);
  }

  if(form.id==="personForm"){
    const kind=form.dataset.kind;
    await saveSimple(form,kind==="owner"?"owners":"tenants",fd=>({
      name:String(fd.get("name")||"").trim(),
      phone:String(fd.get("phone")||"").trim()||null,
      email:String(fd.get("email")||"").trim()||null,
      document:String(fd.get("document")||"").trim()||null,
      notes:String(fd.get("notes")||"").trim()||null
    }));
  }

  if(form.id==="rentalForm"){
    await saveSimple(form,"rentals",fd=>({
      property_id:fd.get("property_id"),
      tenant_id:fd.get("tenant_id")||null,
      owner_id:fd.get("owner_id")||null,
      start_date:fd.get("start_date")||null,
      end_date:fd.get("end_date")||null,
      rented_value:n(fd.get("rented_value")),
      security_deposit:n(fd.get("security_deposit")),
      advisory_fee:n(fd.get("advisory_fee")),
      owner_commission:n(fd.get("owner_commission")),
      owner_commission_paid:fd.get("owner_commission_paid")==="true",
      owner_commission_paid_at:fd.get("owner_commission_paid_at")||null,
      status:fd.get("status"),
      notes:String(fd.get("notes")||"").trim()||null
    }));
  }

  if(form.id==="financeForm"){
    await saveSimple(form,"financial_entries",fd=>({
      property_id:fd.get("property_id")||null,
      rental_id:fd.get("rental_id")||null,
      entry_type:fd.get("entry_type"),
      description:String(fd.get("description")||"").trim()||null,
      amount:n(fd.get("amount")),
      due_date:fd.get("due_date")||null,
      paid_date:fd.get("paid_date")||null,
      status:fd.get("status"),
      notes:String(fd.get("notes")||"").trim()||null
    }));
  }
});

$("#adminContent").addEventListener("submit",async event=>{
  if(event.target.id!=="settingsForm")return;
  event.preventDefault();
  const fd=new FormData(event.target);
  const row={
    site_name:String(fd.get("site_name")||"").trim(),
    hero_title:String(fd.get("hero_title")||"").trim(),
    hero_subtitle:String(fd.get("hero_subtitle")||"").trim()||null,
    whatsapp_number:String(fd.get("whatsapp_number")||"").trim()||null
  };
  const {error}=await db.from("site_settings").update(row).eq("id",true);
  $("#settingsMessage").innerHTML=error?message(error.message):message("Configurações salvas.",true);
  if(!error)await refreshData();
});

$("#loginForm").addEventListener("submit",async event=>{
  event.preventDefault();
  $("#loginMessage").textContent="Entrando...";
  const email=$("#loginEmail").value.trim();
  const password=$("#loginPassword").value;
  const {error}=await db.auth.signInWithPassword({email,password});
  if(error){
    $("#loginMessage").textContent="E-mail ou senha incorretos.";
    return;
  }
  await boot();
});

$("#logoutBtn").addEventListener("click",async()=>{
  await db.auth.signOut();
  location.reload();
});

async function boot(){
  const auth=await isAdmin();

  if(!auth.user){
    $("#loginView").classList.remove("hidden");
    $("#adminView").classList.add("hidden");
    return;
  }

  if(!auth.admin){
    await db.auth.signOut();
    $("#loginMessage").textContent="Esta conta não possui permissão de administrador.";
    $("#loginView").classList.remove("hidden");
    $("#adminView").classList.add("hidden");
    return;
  }

  $("#loginView").classList.add("hidden");
  $("#adminView").classList.remove("hidden");
  await refreshData();
  renderCurrent();
}

boot();
