import { advisorDb as db } from "./config.js?v=202609282145";
import { $, escapeHTML, money } from "./common.js?v=202609281430";

let currentUser=null;
let profile=null;
let properties=[];
let owners=[];
let rentals=[];
let receipts=[];
let ownerCommissions=[];
let collaborations=[];
let notifications=[];
let advisorDirectory=[];

function dateBR(value){
  if(!value) return "—";
  const date=new Date(value);
  if(Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR").format(date);
}
function dateOnlyBR(value){
  if(!value) return "—";
  const raw=String(value).slice(0,10);
  const [y,m,d]=raw.split("-");
  return y&&m&&d?`${d}/${m}/${y}`:"—";
}
function safeDate(value){
  return value?String(value).slice(0,10):"";
}
function nowDateInput(){
  return new Date().toISOString().slice(0,10);
}
function safePdfText(value){
  return String(value??"").replace(/[\r\n]+/g," ").trim();
}
function showModal(html){
  const modal=$("#managementModal");
  modal.innerHTML=`<div class="modal-card">${html}</div>`;
  modal.classList.remove("hidden");
}
function closeModal(){
  const modal=$("#managementModal");
  modal.classList.add("hidden");
  modal.innerHTML="";
}
function ownerById(id){
  return owners.find(o=>o.id===id)||null;
}
function propertyById(id){
  return properties.find(p=>p.id===id)||null;
}
function ownerOptions(selected=""){
  return '<option value="">Sem proprietário vinculado</option>'+
    owners.map(o=>`<option value="${o.id}" ${o.id===selected?"selected":""}>${escapeHTML(o.full_name)} • ${escapeHTML(o.whatsapp||"")}</option>`).join("");
}
function propertyOptions(selected=""){
  return '<option value="">Sem anúncio vinculado</option>'+
    properties.map(p=>`<option value="${p.id}" ${p.id===selected?"selected":""}>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</option>`).join("");
}
function blankTotals(){
  return {BRL:0,PYG:0};
}
function addTotal(target,currency,value){
  const key=currency==="PYG"?"PYG":"BRL";
  target[key]=(target[key]||0)+Number(value||0);
}
function formatTotals(totals){
  const parts=[];
  if(Number(totals.BRL||0)!==0) parts.push(money(totals.BRL,"BRL"));
  if(Number(totals.PYG||0)!==0) parts.push(money(totals.PYG,"PYG"));
  return parts.length?parts.join(" • "):money(0,"BRL");
}
function receiptTotal(row){
  return ["commission_amount","advisory_fee_amount","contract_amount","other_amount"]
    .reduce((sum,key)=>sum+Number(row?.[key]||0),0);
}
function paymentStatus(paid,date){
  if(!paid) return "Pendente";
  return date?`Pago em ${dateOnlyBR(date)}`:"Pago";
}
function ownerMatchesRental(owner,row){
  if(!owner || !row) return false;
  if(row.advisor_owner_id && row.advisor_owner_id===owner.id) return true;
  return String(row.owner_name||"").trim().toLocaleLowerCase("pt-BR")===
    String(owner.full_name||"").trim().toLocaleLowerCase("pt-BR");
}

async function loadData(){
  const [
    profileRes,
    propertiesRes,
    ownersRes,
    rentalsRes,
    receiptsRes,
    commissionsRes,
    collaborationsRes,
    notificationsRes,
    directoryRes
  ]=await Promise.all([
    db.from("advisor_profiles").select("*").eq("user_id",currentUser.id).maybeSingle(),
    db.from("properties")
      .select("id,public_code,title,neighborhood,city,address,is_published,status,listing_started_at,listing_expires_at,view_count,whatsapp_click_count,advisor_owner_id,currency,price")
      .eq("advisor_id",currentUser.id)
      .order("created_at",{ascending:false}),
    db.from("advisor_owners")
      .select("*")
      .eq("advisor_id",currentUser.id)
      .order("full_name"),
    db.from("advisor_rental_control")
      .select("*")
      .eq("advisor_id",currentUser.id)
      .order("start_date",{ascending:false}),
    db.from("advisor_service_receipts")
      .select("*")
      .eq("advisor_id",currentUser.id)
      .order("issued_at",{ascending:false}),
    db.from("advisor_owner_commissions")
      .select("*")
      .eq("advisor_id",currentUser.id)
      .order("status",{ascending:true})
      .order("due_date",{ascending:true}),
    db.from("advisor_collaborations")
      .select("*, advisor_collaboration_participants(*)")
      .order("created_at",{ascending:false}),
    db.from("advisor_notifications")
      .select("*")
      .eq("advisor_id",currentUser.id)
      .order("created_at",{ascending:false})
      .limit(100),
    db.from("advisor_directory")
      .select("user_id,full_name,company_name,city")
      .order("full_name")
  ]);

  const firstError=[
    profileRes.error,
    propertiesRes.error,
    ownersRes.error,
    rentalsRes.error,
    receiptsRes.error,
    commissionsRes.error,
    collaborationsRes.error,
    notificationsRes.error,
    directoryRes.error
  ].find(Boolean);
  if(firstError) throw firstError;

  profile=profileRes.data||null;
  properties=propertiesRes.data||[];
  owners=ownersRes.data||[];
  rentals=rentalsRes.data||[];
  receipts=receiptsRes.data||[];
  ownerCommissions=commissionsRes.data||[];
  collaborations=collaborationsRes.data||[];
  notifications=notificationsRes.data||[];
  advisorDirectory=directoryRes.data||[];
}



function commissionRows(){
  return ownerCommissions.map(row=>{
    const owner=ownerById(row.advisor_owner_id);
    const rental=rentals.find(r=>r.id===row.rental_control_id);
    return {
      id:row.id,
      owner_id:row.advisor_owner_id||null,
      owner_name:owner?.full_name||row.owner_name||"Proprietário não informado",
      owner_whatsapp:owner?.whatsapp||row.owner_whatsapp||"",
      rental_control_id:row.rental_control_id||null,
      property_id:row.property_id||null,
      property_code:row.property_code||rental?.property_code||"—",
      property_title:row.property_title||rental?.property_title||"Imóvel",
      amount:Number(row.amount||0),
      currency:row.currency||"BRL",
      paid:row.status==="received",
      due_date:row.due_date||null,
      payment_date:row.received_at||null,
      created_at:row.created_at
    };
  });
}

function commissionTotals(){
  const received=blankTotals();
  const pending=blankTotals();
  let overdue=0;
  const today=nowDateInput();

  commissionRows().forEach(row=>{
    if(row.paid) addTotal(received,row.currency,row.amount);
    else{
      addTotal(pending,row.currency,row.amount);
      if(row.due_date && row.due_date<today) overdue++;
    }
  });

  return {received,pending,overdue};
}

function tenantAdvisoryRows(){
  return rentals
    .filter(r=>r.had_advisory_fee && Number(r.advisory_fee_amount||0)>0)
    .map(r=>({
      id:r.id,
      tenant_name:r.tenant_name||"Inquilino não informado",
      tenant_whatsapp:r.tenant_phone||"",
      property_code:r.property_code||"—",
      property_title:r.property_title||"Imóvel",
      amount:Number(r.advisory_fee_amount||0),
      currency:r.currency||"BRL",
      paid:Boolean(r.advisory_fee_paid),
      due_date:r.advisory_fee_due_date||null,
      payment_date:r.advisory_fee_payment_date||null,
      start_date:r.start_date||r.created_at
    }));
}

function tenantAdvisoryTotals(){
  const received=blankTotals();
  const pending=blankTotals();
  let overdue=0;
  const today=nowDateInput();

  tenantAdvisoryRows().forEach(row=>{
    if(row.paid) addTotal(received,row.currency,row.amount);
    else{
      addTotal(pending,row.currency,row.amount);
      if(row.due_date && row.due_date<today) overdue++;
    }
  });

  return {received,pending,overdue};
}

function renderOverview(){
  const root=$("#managementOverview");
  if(!root) return;

  const now=Date.now();
  const fiveDays=5*24*60*60*1000;
  const active=properties.filter(p=>
    p.is_published &&
    p.status==="available" &&
    (!p.listing_expires_at || new Date(p.listing_expires_at).getTime()>now)
  );
  const expired=properties.filter(p=>
    !p.is_published ||
    (p.listing_expires_at && new Date(p.listing_expires_at).getTime()<=now)
  );
  const expiring=active
    .filter(p=>p.listing_expires_at && new Date(p.listing_expires_at).getTime()<=now+fiveDays)
    .sort((a,b)=>new Date(a.listing_expires_at)-new Date(b.listing_expires_at));

  const totalViews=properties.reduce((sum,p)=>sum+Number(p.view_count||0),0);
  const totalWhatsapp=properties.reduce((sum,p)=>sum+Number(p.whatsapp_click_count||0),0);
  const topViewed=[...properties]
    .sort((a,b)=>Number(b.view_count||0)-Number(a.view_count||0))
    .slice(0,5);
  const commissions=commissionTotals();
  const tenantAdvisories=tenantAdvisoryTotals();

  root.innerHTML=`
    <section class="advisor-management-hero">
      <div class="advisor-management-title">
        <p class="eyebrow">VISÃO GERAL</p>
        <h2>Sua operação em um só lugar</h2>
        <p>Esta área é somente de gestão. O cadastro e a publicação dos anúncios continuam separados em “Meus anúncios”.</p>
      </div>

      <div class="advisor-kpi-grid">
        <article><span>Anúncios ativos</span><strong>${active.length}</strong><small>${expired.length} expirado${expired.length===1?"":"s"}</small></article>
        <article class="${expiring.length?"attention":""}"><span>Vencem em até 5 dias</span><strong>${expiring.length}</strong><small>anúncios que exigem atenção</small></article>
        <article><span>Imóveis alugados</span><strong>${rentals.length}</strong><small>locações registradas</small></article>
        <article><span>Visualizações</span><strong>${totalViews.toLocaleString("pt-BR")}</strong><small>${totalWhatsapp.toLocaleString("pt-BR")} contatos no WhatsApp</small></article>
        <article class="money attention"><span>Comissões a receber</span><strong>${formatTotals(commissions.pending)}</strong><small>${commissions.overdue} vencida${commissions.overdue===1?"":"s"}</small></article>
        <article class="money result"><span>Comissões recebidas</span><strong>${formatTotals(commissions.received)}</strong><small>pagas pelos proprietários</small></article>
        <article class="money attention"><span>Assessoria a receber</span><strong>${formatTotals(tenantAdvisories.pending)}</strong><small>${tenantAdvisories.overdue} vencida${tenantAdvisories.overdue===1?"":"s"}</small></article>
        <article class="money result"><span>Assessoria recebida</span><strong>${formatTotals(tenantAdvisories.received)}</strong><small>paga pelos inquilinos</small></article>
      </div>

      <div class="advisor-dashboard-columns">
        <section class="advisor-dashboard-box">
          <div class="advisor-dashboard-box-head">
            <div><p class="eyebrow">PRAZOS</p><h3>Anúncios próximos do vencimento</h3></div>
          </div>
          ${expiring.length?`
            <div class="advisor-deadline-list">
              ${expiring.map(p=>{
                const days=Math.max(0,Math.ceil((new Date(p.listing_expires_at).getTime()-now)/(24*60*60*1000)));
                return `<div>
                  <span>
                    <strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong>
                    <small>${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))}</small>
                  </span>
                  <b>${days===0?"Hoje":days===1?"1 dia":`${days} dias`}</b>
                </div>`;
              }).join("")}
            </div>
          `:'<div class="advisor-empty-compact">Nenhum anúncio vence nos próximos 5 dias.</div>'}
          ${expired.length?`
            <div class="advisor-expired-mini-title">Já expirados</div>
            <div class="advisor-deadline-list expired">
              ${expired.slice(0,5).map(p=>`
                <div>
                  <span>
                    <strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong>
                    <small>${p.listing_expires_at?`Venceu em ${dateOnlyBR(p.listing_expires_at)}`:"Fora do ar"}</small>
                  </span>
                  <b>Expirado</b>
                </div>
              `).join("")}
            </div>
          `:""}
        </section>

        <section class="advisor-dashboard-box">
          <div class="advisor-dashboard-box-head">
            <div><p class="eyebrow">DESEMPENHO</p><h3>Imóveis mais visualizados</h3></div>
          </div>
          ${topViewed.length?`
            <div class="advisor-performance-list">
              ${topViewed.map((p,index)=>`
                <div>
                  <span class="rank">${index+1}</span>
                  <span class="info">
                    <strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong>
                    <small>💬 ${Number(p.whatsapp_click_count||0).toLocaleString("pt-BR")} contatos</small>
                  </span>
                  <b>👁 ${Number(p.view_count||0).toLocaleString("pt-BR")}</b>
                </div>
              `).join("")}
            </div>
          `:'<div class="advisor-empty-compact">Os dados de visualização aparecerão aqui.</div>'}
        </section>
      </div>
    </section>
  `;
}


function renderOwners(){
  const root=$("#managementOwnersList");
  if(!root) return;

  if(!owners.length){
    root.innerHTML='<div class="empty-state"><strong>Nenhum proprietário cadastrado.</strong><span>Cadastre somente nome e WhatsApp e depois vincule os imóveis dele.</span></div>';
    return;
  }

  const commissions=commissionRows();

  root.innerHTML=`
    <div class="advisor-owner-grid">
      ${owners.map(owner=>{
        const linked=properties.filter(p=>p.advisor_owner_id===owner.id);
        const linkedRentals=rentals.filter(r=>ownerMatchesRental(owner,r));
        const ownerCommissions=commissions.filter(r=>r.owner_id===owner.id);
        const pending=blankTotals();
        ownerCommissions.filter(r=>!r.paid).forEach(r=>addTotal(pending,r.currency,r.amount));
        const phone=String(owner.whatsapp||"").replace(/\D/g,"");

        return `
          <article class="advisor-owner-card">
            <div class="advisor-owner-card-head">
              <div>
                <p class="eyebrow">PROPRIETÁRIO</p>
                <h3>${escapeHTML(owner.full_name)}</h3>
                <span>WhatsApp: ${escapeHTML(owner.whatsapp||"—")}</span>
              </div>
              <div class="table-actions">
                <button class="btn ghost compact" type="button" data-link-owner-properties="${owner.id}">Imóveis</button>
                <button class="btn ghost compact" type="button" data-edit-owner="${owner.id}">Editar</button>
                <button class="btn danger compact" type="button" data-delete-owner="${owner.id}">Excluir</button>
              </div>
            </div>

            <div class="advisor-owner-stats compact-owner-stats">
              <div><span>Imóveis</span><strong>${linked.length}</strong></div>
              <div><span>Alugados</span><strong>${linkedRentals.length}</strong></div>
              <div><span>Comissão a receber</span><strong>${formatTotals(pending)}</strong></div>
            </div>

            ${phone?`<div class="advisor-owner-contact"><a class="btn whatsapp compact" href="https://wa.me/${phone}" target="_blank" rel="noopener">💬 Abrir WhatsApp</a></div>`:""}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function ownerModal(row=null){
  showModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">PROPRIETÁRIO</p>
        <h2>${row?"Editar proprietário":"Cadastrar proprietário"}</h2>
        <p class="muted">Informações privadas, visíveis somente na gestão do assessor.</p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>✕</button>
    </div>

    <form id="managementOwnerForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label class="span-2">Nome do proprietário
        <input name="full_name" required value="${escapeHTML(row?.full_name||"")}" autocomplete="name">
      </label>
      <label class="span-2">WhatsApp
        <input name="whatsapp" required inputmode="tel" value="${escapeHTML(row?.whatsapp||"")}" placeholder="Ex.: 595981123456">
        <small>Somente para seu controle interno. Esse número não aparece no anúncio.</small>
      </label>

      <div id="managementOwnerMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close-modal>Cancelar</button>
        <button id="managementOwnerSaveBtn" class="btn primary" type="button">Salvar proprietário</button>
      </div>
    </form>
  `);

  const form=$("#managementOwnerForm");
  const saveButton=$("#managementOwnerSaveBtn");

  const triggerSave=async()=>{
    if(!form) return;
    if(!form.reportValidity()) return;
    await saveOwner(form);
  };

  saveButton?.addEventListener("click",async e=>{
    e.preventDefault();
    e.stopPropagation();
    await triggerSave();
  });

  form?.addEventListener("submit",async e=>{
    e.preventDefault();
    e.stopPropagation();
    await triggerSave();
  });
}



async function saveOwner(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const msg=form.querySelector("#managementOwnerMessage");
  const submit=form.querySelector("#managementOwnerSaveBtn");
  const originalText=submit?.textContent||"Salvar proprietário";

  const fullName=String(fd.get("full_name")||"").trim();
  const whatsapp=String(fd.get("whatsapp")||"").replace(/\D/g,"").trim();

  if(!currentUser?.id){
    if(msg) msg.textContent="Sua sessão expirou. Entre novamente na Área do Assessor.";
    return;
  }
  if(!fullName){
    if(msg) msg.textContent="Informe o nome do proprietário.";
    return;
  }
  if(whatsapp.length<8){
    if(msg) msg.textContent="Informe um WhatsApp válido.";
    return;
  }

  if(submit){
    submit.disabled=true;
    submit.textContent="Salvando...";
  }
  if(msg) msg.textContent="Salvando proprietário...";

  try{
    const {data,error}=await db.rpc("save_advisor_owner",{
      p_full_name:fullName,
      p_whatsapp:whatsapp,
      p_owner_id:id
    });

    if(error) throw error;
    if(!data?.id) throw new Error("O cadastro não retornou confirmação do banco.");

    if(id){
      owners=owners.map(owner=>owner.id===data.id?data:owner);
    }else if(!owners.some(owner=>owner.id===data.id)){
      owners=[...owners,data];
    }

    owners.sort((a,b)=>String(a.full_name||"").localeCompare(String(b.full_name||""),"pt-BR"));

    if(msg) msg.textContent="Proprietário salvo com sucesso ✓";
    if(submit) submit.textContent="Salvo ✓";

    try{ renderOwners(); }catch(renderError){ console.warn("Proprietário salvo; falha apenas ao redesenhar a lista:",renderError); }

    setTimeout(()=>{
      closeModal();
      switchView("owners");
    },300);
  }catch(err){
    console.error("Erro ao salvar proprietário:",err);
    if(msg) msg.textContent=err?.message||"Não foi possível salvar o proprietário.";
    if(submit){
      submit.disabled=false;
      submit.textContent=originalText;
    }
  }
}

function ownerPropertiesModal(owner){
  const selected=new Set(properties.filter(p=>p.advisor_owner_id===owner.id).map(p=>p.id));
  showModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">VINCULAR IMÓVEIS</p>
        <h2>${escapeHTML(owner.full_name)}</h2>
        <p class="muted">Marque todos os imóveis que pertencem a este proprietário. Você pode vincular anúncios ativos ou expirados.</p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>✕</button>
    </div>

    <form id="managementOwnerPropertiesForm" class="form-stack">
      <input type="hidden" name="owner_id" value="${owner.id}">
      <div class="management-property-checklist">
        ${properties.length?properties.map(p=>{
          const currentOwner=ownerById(p.advisor_owner_id);
          const expired=p.listing_expires_at && new Date(p.listing_expires_at)<=new Date();
          return `
            <label class="management-property-choice">
              <input type="checkbox" name="property_ids" value="${p.id}" ${selected.has(p.id)?"checked":""}>
              <span>
                <strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong>
                <small>${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))} • ${expired?"Expirado":"Ativo"}${currentOwner && currentOwner.id!==owner.id?` • atualmente: ${escapeHTML(currentOwner.full_name)}`:""}</small>
              </span>
            </label>
          `;
        }).join(""):'<div class="empty-state"><strong>Nenhum anúncio cadastrado.</strong></div>'}
      </div>
      <div id="managementOwnerPropertiesMessage" class="form-message"></div>
      <div class="form-actions">
        <button class="btn ghost" type="button" data-close-modal>Cancelar</button>
        <button class="btn primary" type="submit">Salvar vínculos</button>
      </div>
    </form>
  `);
}

async function saveOwnerProperties(form){
  const fd=new FormData(form);
  const ownerId=String(fd.get("owner_id")||"");
  const selectedIds=new Set(fd.getAll("property_ids").map(String));
  const msg=form.querySelector("#managementOwnerPropertiesMessage");
  const ownIds=properties.filter(p=>p.advisor_owner_id===ownerId).map(p=>p.id);
  const toRemove=ownIds.filter(id=>!selectedIds.has(id));
  const toAdd=[...selectedIds];

  msg.textContent="Salvando vínculos...";

  if(toRemove.length){
    const remove=await db.from("properties")
      .update({advisor_owner_id:null})
      .in("id",toRemove)
      .eq("advisor_id",currentUser.id);
    if(remove.error){
      msg.textContent=remove.error.message;
      return;
    }
  }

  if(toAdd.length){
    const add=await db.from("properties")
      .update({advisor_owner_id:ownerId})
      .in("id",toAdd)
      .eq("advisor_id",currentUser.id);
    if(add.error){
      msg.textContent=add.error.message;
      return;
    }
  }

  await refreshAndRender();
  closeModal();
  switchView("owners");
}




function renderFinance(){
  const root=$("#managementFinanceContent");
  if(!root) return;

  const commissionData=commissionRows().sort((a,b)=>{
    if(a.paid!==b.paid) return a.paid?1:-1;
    return String(a.due_date||"9999-12-31").localeCompare(String(b.due_date||"9999-12-31"));
  });
  const advisoryData=tenantAdvisoryRows().sort((a,b)=>{
    if(a.paid!==b.paid) return a.paid?1:-1;
    return String(a.due_date||"9999-12-31").localeCompare(String(b.due_date||"9999-12-31"));
  });

  const commissionSummary=commissionTotals();
  const advisorySummary=tenantAdvisoryTotals();
  const pendingOwners=new Set(commissionData.filter(r=>!r.paid).map(r=>r.owner_id||r.owner_name));
  const pendingTenants=new Set(advisoryData.filter(r=>!r.paid).map(r=>r.tenant_name));

  root.innerHTML=`
    <div class="receivables-stack">
      <section class="advisor-dashboard-box receivable-section">
        <div class="receivable-section-head">
          <div>
            <p class="eyebrow">PROPRIETÁRIO → CORRETOR</p>
            <h3>Comissão do proprietário</h3>
            <p>Controle somente o valor que o proprietário deve ou já pagou de comissão.</p>
          </div>
        </div>

        <div class="commission-summary-grid compact-summary">
          <article class="commission-summary-card pending">
            <span>A receber</span>
            <strong>${formatTotals(commissionSummary.pending)}</strong>
            <small>${pendingOwners.size} proprietário${pendingOwners.size===1?"":"s"} pendente${pendingOwners.size===1?"":"s"}</small>
          </article>
          <article class="commission-summary-card received">
            <span>Recebidas</span>
            <strong>${formatTotals(commissionSummary.received)}</strong>
            <small>comissões confirmadas</small>
          </article>
          <article class="commission-summary-card ${commissionSummary.overdue?"overdue":""}">
            <span>Vencidas</span>
            <strong>${commissionSummary.overdue}</strong>
            <small>fora do prazo</small>
          </article>
        </div>

        ${commissionData.length?`
          <div class="admin-table-wrap">
            <table class="admin-table commission-table">
              <thead>
                <tr><th>Proprietário</th><th>Imóvel</th><th>Comissão</th><th>Vencimento</th><th>Status</th><th>Ações</th></tr>
              </thead>
              <tbody>
                ${commissionData.map(r=>{
                  const overdue=!r.paid && r.due_date && r.due_date<nowDateInput();
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHTML(r.owner_name)}</strong>
                        ${r.owner_whatsapp?`<br><span class="muted">${escapeHTML(r.owner_whatsapp)}</span>`:""}
                      </td>
                      <td><strong>${escapeHTML(r.property_code||"—")}</strong><br><span class="muted">${escapeHTML(r.property_title||"")}</span></td>
                      <td><strong>${money(r.amount,r.currency)}</strong></td>
                      <td>${r.due_date?dateOnlyBR(r.due_date):'<span class="muted">Sem vencimento</span>'}</td>
                      <td>
                        <span class="pill ${r.paid?"paid":overdue?"expense":"pending"}">${r.paid?"RECEBIDA":overdue?"VENCIDA":"A RECEBER"}</span>
                        ${r.paid && r.payment_date?`<br><small>${dateOnlyBR(r.payment_date)}</small>`:""}
                      </td>
                      <td>
                        <div class="table-actions">
                          <button class="btn ghost compact" type="button" data-edit-commission="${r.id}">Editar</button>
                          ${r.paid
                            ? `<button class="btn ghost compact" type="button" data-mark-commission-pending="${r.id}">Desfazer</button>`
                            : `<button class="btn primary compact" type="button" data-mark-commission-paid="${r.id}">✓ Recebida</button>`
                          }
                          <button class="btn danger compact" type="button" data-delete-owner-commission="${r.id}">Excluir</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `:'<div class="advisor-empty-compact">Nenhuma comissão cadastrada. Use “+ Comissão do proprietário”.</div>'}
      </section>

      <section class="advisor-dashboard-box receivable-section tenant-advisory-section">
        <div class="receivable-section-head">
          <div>
            <p class="eyebrow">INQUILINO → ASSESSOR</p>
            <h3>Taxa de assessoria do inquilino</h3>
            <p>Controle a assessoria cobrada do inquilino separadamente da comissão do proprietário.</p>
          </div>
        </div>

        <div class="commission-summary-grid compact-summary">
          <article class="commission-summary-card pending">
            <span>A receber</span>
            <strong>${formatTotals(advisorySummary.pending)}</strong>
            <small>${pendingTenants.size} inquilino${pendingTenants.size===1?"":"s"} pendente${pendingTenants.size===1?"":"s"}</small>
          </article>
          <article class="commission-summary-card received">
            <span>Recebidas</span>
            <strong>${formatTotals(advisorySummary.received)}</strong>
            <small>assessorias confirmadas</small>
          </article>
          <article class="commission-summary-card ${advisorySummary.overdue?"overdue":""}">
            <span>Vencidas</span>
            <strong>${advisorySummary.overdue}</strong>
            <small>fora do prazo</small>
          </article>
        </div>

        ${advisoryData.length?`
          <div class="admin-table-wrap">
            <table class="admin-table commission-table">
              <thead>
                <tr><th>Inquilino</th><th>Imóvel</th><th>Assessoria</th><th>Vencimento</th><th>Status</th><th>Ações</th></tr>
              </thead>
              <tbody>
                ${advisoryData.map(r=>{
                  const overdue=!r.paid && r.due_date && r.due_date<nowDateInput();
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHTML(r.tenant_name)}</strong>
                        ${r.tenant_whatsapp?`<br><span class="muted">${escapeHTML(r.tenant_whatsapp)}</span>`:""}
                      </td>
                      <td><strong>${escapeHTML(r.property_code||"—")}</strong><br><span class="muted">${escapeHTML(r.property_title||"")}</span></td>
                      <td><strong>${money(r.amount,r.currency)}</strong></td>
                      <td>${r.due_date?dateOnlyBR(r.due_date):'<span class="muted">Sem vencimento</span>'}</td>
                      <td>
                        <span class="pill ${r.paid?"paid":overdue?"expense":"pending"}">${r.paid?"RECEBIDA":overdue?"VENCIDA":"A RECEBER"}</span>
                        ${r.paid && r.payment_date?`<br><small>${dateOnlyBR(r.payment_date)}</small>`:""}
                      </td>
                      <td>
                        <div class="table-actions">
                          <button class="btn ghost compact" type="button" data-edit-tenant-advisory="${r.id}">Editar</button>
                          ${r.paid
                            ? `<button class="btn ghost compact" type="button" data-mark-tenant-advisory-pending="${r.id}">Desfazer</button>`
                            : `<button class="btn primary compact" type="button" data-mark-tenant-advisory-paid="${r.id}">✓ Recebida</button>`
                          }
                        </div>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `:'<div class="advisor-empty-compact">Nenhuma assessoria do inquilino cadastrada. Use “+ Assessoria do inquilino”.</div>'}
      </section>
    </div>
  `;
}

function rentalOptions(selected=""){
  return '<option value="">Sem locação vinculada</option>'+
    rentals.map(r=>`<option value="${r.id}" ${r.id===selected?"selected":""}>${escapeHTML(r.property_code||"—")} • ${escapeHTML(r.property_title||"Imóvel")}</option>`).join("");
}

function commissionModal(row=null){
  const linkedRental=rentals.find(r=>r.id===row?.rental_control_id)||null;
  const selectedOwner=row?.advisor_owner_id||linkedRental?.advisor_owner_id||"";

  showModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">COMISSÃO DO PROPRIETÁRIO</p>
        <h2>${row?"Editar comissão":"Nova comissão"}</h2>
        <p class="muted">Controle interno do que o proprietário já pagou ou ainda deve ao corretor.</p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>✕</button>
    </div>

    <form id="managementCommissionForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">

      <label class="span-2">Proprietário
        <select name="advisor_owner_id" required>
          ${ownerOptions(selectedOwner)}
        </select>
        <small>Somente nome e WhatsApp; essas informações são privadas.</small>
      </label>

      <label class="span-2">Locação vinculada
        <select name="rental_control_id">
          ${rentalOptions(row?.rental_control_id||"")}
        </select>
        <small>Opcional. Use para relacionar a comissão a um imóvel alugado.</small>
      </label>

      <label>Código / referência do imóvel
        <input name="property_code" value="${escapeHTML(row?.property_code||linkedRental?.property_code||"")}">
      </label>
      <label>Imóvel
        <input name="property_title" value="${escapeHTML(row?.property_title||linkedRental?.property_title||"")}">
      </label>

      <label>Moeda
        <select name="currency">
          <option value="BRL" ${(row?.currency||"BRL")==="BRL"?"selected":""}>Real (R$)</option>
          <option value="PYG" ${row?.currency==="PYG"?"selected":""}>Guarani (₲)</option>
        </select>
      </label>
      <label>Valor da comissão
        <input name="amount" type="number" min="0.01" step="0.01" required value="${row?.amount??""}">
      </label>

      <label>Vencimento
        <input name="due_date" type="date" value="${safeDate(row?.due_date)}">
      </label>
      <label>Status
        <select name="status">
          <option value="pending" ${(row?.status||"pending")==="pending"?"selected":""}>A receber</option>
          <option value="received" ${row?.status==="received"?"selected":""}>Recebida</option>
        </select>
      </label>

      <label class="span-2">Data do recebimento
        <input name="received_at" type="date" value="${safeDate(row?.received_at)}">
      </label>

      <div id="managementCommissionMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close-modal>Cancelar</button>
        <button class="btn primary" type="submit">Salvar comissão</button>
      </div>
    </form>
  `);

  const form=$("#managementCommissionForm");
  const rentalSelect=form?.querySelector('[name="rental_control_id"]');
  rentalSelect?.addEventListener("change",()=>{
    const rental=rentals.find(r=>r.id===rentalSelect.value);
    if(!rental) return;
    const ownerSelect=form.querySelector('[name="advisor_owner_id"]');
    if(rental.advisor_owner_id && ownerSelect) ownerSelect.value=rental.advisor_owner_id;
    const code=form.querySelector('[name="property_code"]');
    const title=form.querySelector('[name="property_title"]');
    if(code) code.value=rental.property_code||"";
    if(title) title.value=rental.property_title||"";
  });
}

async function saveCommission(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const owner=ownerById(String(fd.get("advisor_owner_id")||""));
  const rental=rentals.find(r=>r.id===String(fd.get("rental_control_id")||""))||null;
  const msg=form.querySelector("#managementCommissionMessage");
  const status=fd.get("status")==="received"?"received":"pending";
  const amount=Number(fd.get("amount")||0);

  if(!owner){
    msg.textContent="Selecione o proprietário responsável.";
    return;
  }
  if(!(amount>0)){
    msg.textContent="Informe um valor de comissão maior que zero.";
    return;
  }

  const row={
    advisor_id:currentUser.id,
    advisor_owner_id:owner.id,
    owner_name:owner.full_name,
    owner_whatsapp:owner.whatsapp,
    rental_control_id:rental?.id||null,
    property_id:rental?.property_id||null,
    property_code:String(fd.get("property_code")||rental?.property_code||"").trim()||null,
    property_title:String(fd.get("property_title")||rental?.property_title||"").trim()||null,
    amount,
    currency:fd.get("currency")||"BRL",
    due_date:fd.get("due_date")||null,
    status,
    received_at:status==="received"?(fd.get("received_at")||nowDateInput()):null,
    updated_at:new Date().toISOString()
  };

  const result=id
    ? await db.from("advisor_owner_commissions").update(row).eq("id",id).eq("advisor_id",currentUser.id)
    : await db.from("advisor_owner_commissions").insert(row);

  if(result.error){
    msg.textContent=result.error.message;
    return;
  }

  await refreshAndRender();
  closeModal();
  switchView("finance");
}

async function setCommissionPaid(id,paid){
  const {error}=await db.from("advisor_owner_commissions")
    .update({
      status:paid?"received":"pending",
      received_at:paid?nowDateInput():null,
      updated_at:new Date().toISOString()
    })
    .eq("id",id)
    .eq("advisor_id",currentUser.id);

  if(error){
    alert(error.message);
    return;
  }

  await refreshAndRender();
  switchView("finance");
}


function tenantAdvisoryModal(rental=null){
  showModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">ASSESSORIA DO INQUILINO</p>
        <h2>${rental?.had_advisory_fee?"Editar assessoria":"Nova assessoria"}</h2>
        <p class="muted">Controle somente a taxa de assessoria paga pelo inquilino. Ela fica separada da comissão do proprietário.</p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>✕</button>
    </div>

    <form id="managementTenantAdvisoryForm" class="form-grid">
      <label class="span-2">Locação / imóvel
        <select name="rental_control_id" required>
          ${rentalOptions(rental?.id||"")}
        </select>
      </label>

      <label>Inquilino
        <input name="tenant_name" value="${escapeHTML(rental?.tenant_name||"")}" readonly>
      </label>
      <label>WhatsApp
        <input name="tenant_phone" value="${escapeHTML(rental?.tenant_phone||"")}" readonly>
      </label>

      <label class="span-2">Imóvel
        <input name="property_label" value="${escapeHTML(rental?`${rental.property_code||"—"} • ${rental.property_title||"Imóvel"}`:"")}" readonly>
      </label>

      <label>Valor da assessoria
        <input name="advisory_fee_amount" type="number" min="0.01" step="0.01" required value="${rental?.advisory_fee_amount??""}">
      </label>
      <label>Vencimento
        <input name="advisory_fee_due_date" type="date" value="${safeDate(rental?.advisory_fee_due_date)}">
      </label>

      <label>Status
        <select name="advisory_fee_paid">
          <option value="false" ${!rental?.advisory_fee_paid?"selected":""}>A receber</option>
          <option value="true" ${rental?.advisory_fee_paid?"selected":""}>Recebida</option>
        </select>
      </label>
      <label>Data do recebimento
        <input name="advisory_fee_payment_date" type="date" value="${safeDate(rental?.advisory_fee_payment_date)}">
      </label>

      <div id="managementTenantAdvisoryMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close-modal>Cancelar</button>
        <button class="btn primary" type="submit">Salvar assessoria</button>
      </div>
    </form>
  `);

  const form=$("#managementTenantAdvisoryForm");
  const select=form?.querySelector('[name="rental_control_id"]');

  const fill=(row)=>{
    if(!form || !row) return;
    form.querySelector('[name="tenant_name"]').value=row.tenant_name||"";
    form.querySelector('[name="tenant_phone"]').value=row.tenant_phone||"";
    form.querySelector('[name="property_label"]').value=`${row.property_code||"—"} • ${row.property_title||"Imóvel"}`;
    if(row.advisory_fee_amount!=null) form.querySelector('[name="advisory_fee_amount"]').value=row.advisory_fee_amount;
    form.querySelector('[name="advisory_fee_due_date"]').value=safeDate(row.advisory_fee_due_date);
    form.querySelector('[name="advisory_fee_paid"]').value=row.advisory_fee_paid?"true":"false";
    form.querySelector('[name="advisory_fee_payment_date"]').value=safeDate(row.advisory_fee_payment_date);
  };

  select?.addEventListener("change",()=>{
    fill(rentals.find(item=>item.id===select.value));
  });
}

async function saveTenantAdvisory(form){
  const fd=new FormData(form);
  const rentalId=String(fd.get("rental_control_id")||"");
  const rental=rentals.find(item=>item.id===rentalId);
  const msg=form.querySelector("#managementTenantAdvisoryMessage");
  const amount=Number(fd.get("advisory_fee_amount")||0);
  const paid=fd.get("advisory_fee_paid")==="true";

  if(!rental){
    msg.textContent="Selecione uma locação.";
    return;
  }
  if(!(amount>0)){
    msg.textContent="Informe um valor de assessoria maior que zero.";
    return;
  }

  const {error}=await db.from("advisor_rental_control")
    .update({
      had_advisory_fee:true,
      advisory_fee_amount:amount,
      advisory_fee_due_date:fd.get("advisory_fee_due_date")||null,
      advisory_fee_paid:paid,
      advisory_fee_payment_date:paid?(fd.get("advisory_fee_payment_date")||nowDateInput()):null,
      updated_at:new Date().toISOString()
    })
    .eq("id",rental.id)
    .eq("advisor_id",currentUser.id);

  if(error){
    msg.textContent=error.message;
    return;
  }

  await refreshAndRender();
  closeModal();
  switchView("finance");
}

async function setTenantAdvisoryPaid(id,paid){
  const {error}=await db.from("advisor_rental_control")
    .update({
      advisory_fee_paid:paid,
      advisory_fee_payment_date:paid?nowDateInput():null,
      updated_at:new Date().toISOString()
    })
    .eq("id",id)
    .eq("advisor_id",currentUser.id);

  if(error){
    alert(error.message);
    return;
  }

  await refreshAndRender();
  switchView("finance");
}


function renderReceipts(){
  const root=$("#managementReceiptsList");
  if(!root) return;

  if(!receipts.length){
    root.innerHTML='<div class="empty-state"><strong>Nenhum recibo de assessoria.</strong><span>O recibo é voluntário e não encerra o anúncio do imóvel.</span></div>';
    return;
  }

  root.innerHTML=`
    <div class="admin-table-wrap">
      <table class="admin-table advisor-service-receipt-table">
        <thead><tr><th>Recibo</th><th>Imóvel</th><th>Proprietário</th><th>Cliente</th><th>Total</th><th>Pagamento</th><th>Ações</th></tr></thead>
        <tbody>
          ${receipts.map(r=>`
            <tr>
              <td><strong>${escapeHTML(r.receipt_code||"—")}</strong><br><span class="muted">${dateOnlyBR(r.payment_date||r.issued_at)}</span></td>
              <td><strong>${escapeHTML(r.property_code||"—")}</strong><br><span class="muted">${escapeHTML(r.property_title||"Sem imóvel vinculado")}</span></td>
              <td><strong>${escapeHTML(r.owner_name||"—")}</strong><br><span class="muted">${escapeHTML(r.owner_phone||"")}</span></td>
              <td><strong>${escapeHTML(r.client_name||"—")}</strong><br><span class="muted">${escapeHTML(r.client_phone||"")}</span></td>
              <td><strong>${money(receiptTotal(r),r.currency||"BRL")}</strong></td>
              <td><span class="pill ${r.paid?"paid":"pending"}">${r.paid?"Recebido":"Pendente"}</span><br><span class="muted">${escapeHTML(r.payment_method||"")}</span></td>
              <td>
                <div class="table-actions">
                  <button class="btn primary compact" type="button" data-pdf-receipt="${r.id}">PDF</button>
                  <button class="btn ghost compact" type="button" data-edit-receipt="${r.id}">Editar</button>
                  <button class="btn danger compact" type="button" data-delete-receipt="${r.id}">Excluir</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="tiny-note">Recibos voluntários registram as informações declaradas pelo assessor e não substituem contrato de locação, contrato de assessoria ou orientação jurídica.</p>
  `;
}

function receiptModal(row=null){
  const linkedProperty=propertyById(row?.property_id);
  const ownerId=row?.advisor_owner_id||linkedProperty?.advisor_owner_id||"";
  const linkedOwner=ownerById(ownerId);

  showModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">RECIBO VOLUNTÁRIO</p>
        <h2>${row?"Editar recibo":"Gerar recibo de assessoria"}</h2>
        <p class="muted">O recibo é independente do status do anúncio e não marca o imóvel como alugado.</p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>✕</button>
    </div>

    <form id="managementReceiptForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">

      <div class="form-section-title">Imóvel</div>
      <label class="span-2">Anúncio vinculado
        <select name="property_id">${propertyOptions(row?.property_id||"")}</select>
      </label>
      <label>Código / referência
        <input name="property_code" value="${escapeHTML(row?.property_code||linkedProperty?.public_code||"")}">
      </label>
      <label>Nome / descrição do imóvel
        <input name="property_title" value="${escapeHTML(row?.property_title||linkedProperty?.title||"")}">
      </label>
      <label class="span-2">Endereço
        <input name="property_address" value="${escapeHTML(row?.property_address||(linkedProperty?[linkedProperty.address,linkedProperty.neighborhood,linkedProperty.city].filter(Boolean).join(" • "):""))}">
      </label>

      <div class="form-section-title">Proprietário</div>
      <label class="span-2">Proprietário cadastrado
        <select name="advisor_owner_id">${ownerOptions(ownerId)}</select>
      </label>
      <label>Nome
        <input name="owner_name" required value="${escapeHTML(row?.owner_name||linkedOwner?.full_name||"")}">
      </label>
      <label>WhatsApp
        <input name="owner_phone" required inputmode="tel" value="${escapeHTML(row?.owner_phone||linkedOwner?.whatsapp||"")}">
      </label>

      <div class="form-section-title">Cliente / inquilino</div>
      <label>Nome
        <input name="client_name" value="${escapeHTML(row?.client_name||"")}">
      </label>
      <label>Telefone
        <input name="client_phone" inputmode="tel" value="${escapeHTML(row?.client_phone||"")}">
      </label>

      <div class="form-section-title">Serviço e valores</div>
      <label class="span-2">Descrição do serviço
        <textarea name="service_description" required rows="3">${escapeHTML(row?.service_description||"Serviço de assessoria imobiliária")}</textarea>
      </label>
      <label>Moeda
        <select name="currency">
          <option value="BRL" ${(row?.currency||"BRL")==="BRL"?"selected":""}>Real (R$)</option>
          <option value="PYG" ${row?.currency==="PYG"?"selected":""}>Guarani (₲)</option>
        </select>
      </label>
      <div></div>
      <label>Comissão
        <input name="commission_amount" type="number" min="0" step="1" value="${row?.commission_amount??0}">
      </label>
      <label>Taxa de assessoria
        <input name="advisory_fee_amount" type="number" min="0" step="1" value="${row?.advisory_fee_amount??0}">
      </label>
      <label>Contrato / documentação
        <input name="contract_amount" type="number" min="0" step="1" value="${row?.contract_amount??0}">
      </label>
      <label>Outros valores
        <input name="other_amount" type="number" min="0" step="1" value="${row?.other_amount??0}">
      </label>
      <div class="span-2 receipt-total-preview">Total do recibo: <strong id="managementReceiptTotal">—</strong></div>

      <div class="form-section-title">Pagamento</div>
      <label>Pagamento recebido?
        <select name="paid">
          <option value="true" ${row?.paid!==false?"selected":""}>Sim</option>
          <option value="false" ${row?.paid===false?"selected":""}>Ainda não</option>
        </select>
      </label>
      <label>Data do pagamento
        <input name="payment_date" type="date" value="${safeDate(row?.payment_date)||nowDateInput()}">
      </label>
      <label>Forma de pagamento
        <select name="payment_method">
          <option value="">Selecione</option>
          <option value="PIX" ${row?.payment_method==="PIX"?"selected":""}>PIX</option>
          <option value="Dinheiro" ${row?.payment_method==="Dinheiro"?"selected":""}>Dinheiro</option>
          <option value="Transferência" ${row?.payment_method==="Transferência"?"selected":""}>Transferência</option>
          <option value="Cartão" ${row?.payment_method==="Cartão"?"selected":""}>Cartão</option>
          <option value="Outro" ${row?.payment_method==="Outro"?"selected":""}>Outro</option>
        </select>
      </label>
      <label>Referência / comprovante
        <input name="payment_reference" value="${escapeHTML(row?.payment_reference||"")}">
      </label>
      <label class="span-2">Observações
        <textarea name="notes" rows="3">${escapeHTML(row?.notes||"")}</textarea>
      </label>

      <div id="managementReceiptMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close-modal>Cancelar</button>
        <button class="btn primary" type="submit">Salvar e gerar PDF</button>
      </div>
    </form>
  `);

  wireReceiptForm($("#managementReceiptForm"));
}

function wireReceiptForm(form){
  if(!form) return;
  const propertySelect=form.querySelector('[name="property_id"]');
  const ownerSelect=form.querySelector('[name="advisor_owner_id"]');
  const amountNames=["commission_amount","advisory_fee_amount","contract_amount","other_amount"];

  const fillOwner=(owner)=>{
    if(!owner) return;
    form.querySelector('[name="owner_name"]').value=owner.full_name||"";
    form.querySelector('[name="owner_phone"]').value=owner.whatsapp||"";
  };

  propertySelect?.addEventListener("change",()=>{
    const p=propertyById(propertySelect.value);
    if(!p) return;
    form.querySelector('[name="property_code"]').value=p.public_code||"";
    form.querySelector('[name="property_title"]').value=p.title||"";
    form.querySelector('[name="property_address"]').value=[p.address,p.neighborhood,p.city].filter(Boolean).join(" • ");
    if(p.advisor_owner_id){
      ownerSelect.value=p.advisor_owner_id;
      fillOwner(ownerById(p.advisor_owner_id));
    }
  });

  ownerSelect?.addEventListener("change",()=>fillOwner(ownerById(ownerSelect.value)));

  const updateTotal=()=>{
    const total=amountNames.reduce((sum,name)=>sum+Number(form.querySelector(`[name="${name}"]`)?.value||0),0);
    $("#managementReceiptTotal").textContent=money(total,form.querySelector('[name="currency"]')?.value||"BRL");
  };
  amountNames.forEach(name=>form.querySelector(`[name="${name}"]`)?.addEventListener("input",updateTotal));
  form.querySelector('[name="currency"]')?.addEventListener("change",updateTotal);
  updateTotal();
}

async function saveReceipt(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const property=propertyById(String(fd.get("property_id")||""));
  const owner=ownerById(String(fd.get("advisor_owner_id")||""));
  const msg=form.querySelector("#managementReceiptMessage");

  const row={
    advisor_id:currentUser.id,
    property_id:property?.id||null,
    advisor_owner_id:owner?.id||null,
    property_code:String(fd.get("property_code")||property?.public_code||"").trim()||null,
    property_title:String(fd.get("property_title")||property?.title||"").trim()||null,
    property_address:String(fd.get("property_address")||(property?[property.address,property.neighborhood,property.city].filter(Boolean).join(" • "):"")).trim()||null,
    owner_name:String(fd.get("owner_name")||"").trim(),
    owner_phone:String(fd.get("owner_phone")||"").trim()||null,
    client_name:String(fd.get("client_name")||"").trim()||null,
    client_phone:String(fd.get("client_phone")||"").trim()||null,
    service_description:String(fd.get("service_description")||"").trim(),
    currency:fd.get("currency")||"BRL",
    commission_amount:Number(fd.get("commission_amount")||0),
    advisory_fee_amount:Number(fd.get("advisory_fee_amount")||0),
    contract_amount:Number(fd.get("contract_amount")||0),
    other_amount:Number(fd.get("other_amount")||0),
    paid:fd.get("paid")==="true",
    payment_date:fd.get("paid")==="true"?(fd.get("payment_date")||null):null,
    payment_method:String(fd.get("payment_method")||"").trim()||null,
    payment_reference:String(fd.get("payment_reference")||"").trim()||null,
    include_in_financials:false,
    notes:String(fd.get("notes")||"").trim()||null,
    updated_at:new Date().toISOString()
  };

  if(!row.owner_name || !row.owner_phone || !row.service_description){
    msg.textContent="Informe proprietário, WhatsApp e descrição do serviço.";
    return;
  }
  if(receiptTotal(row)<=0){
    msg.textContent="Informe pelo menos um valor maior que zero.";
    return;
  }
  if(row.paid && !row.payment_date){
    msg.textContent="Informe a data do pagamento.";
    return;
  }
  if(row.paid && !row.payment_method){
    msg.textContent="Informe a forma de pagamento.";
    return;
  }

  const result=id
    ? await db.from("advisor_service_receipts").update(row).eq("id",id).eq("advisor_id",currentUser.id).select("*").single()
    : await db.from("advisor_service_receipts").insert(row).select("*").single();

  if(result.error){
    msg.textContent=result.error.message;
    return;
  }

  await refreshAndRender();
  closeModal();
  switchView("receipts");
  const saved=receipts.find(r=>r.id===result.data?.id)||result.data;
  if(saved) generateServiceReceiptPdf(saved);
}

function generateServiceReceiptPdf(row){
  const JsPDF=window.jspdf?.jsPDF;
  if(!JsPDF){
    alert("O gerador de PDF ainda não carregou. Atualize a página e tente novamente.");
    return;
  }

  const doc=new JsPDF({unit:"mm",format:"a4"});
  const left=18;
  const right=192;
  const width=right-left;
  let y=18;

  const section=(title)=>{
    y+=3;
    doc.setFont("helvetica","bold");
    doc.setFontSize(11.5);
    doc.setTextColor(19,35,59);
    doc.text(title,left,y);
    doc.setTextColor(0);
    y+=7;
  };

  const line=(label,value)=>{
    if(value===null || value===undefined || value==="") return;
    if(y>258){
      doc.addPage();
      y=20;
    }
    doc.setFont("helvetica","bold");
    doc.setFontSize(9.5);
    doc.text(label,left,y);
    doc.setFont("helvetica","normal");
    const txt=doc.splitTextToSize(safePdfText(value),width-48);
    doc.text(txt,left+48,y);
    y+=Math.max(6,txt.length*4.7);
  };

  doc.setFillColor(19,35,59);
  doc.roundedRect(left,y,width,25,3,3,"F");
  doc.setTextColor(255);
  doc.setFont("helvetica","bold");
  doc.setFontSize(16.5);
  doc.text("RECIBO DE ASSESSORIA IMOBILIÁRIA",left+5,y+9);
  doc.setFont("helvetica","normal");
  doc.setFontSize(9);
  doc.text(`${safePdfText(row.receipt_code||"RECIBO")} • Emitido em ${new Intl.DateTimeFormat("pt-BR").format(new Date())}`,left+5,y+17);
  doc.setTextColor(0);
  y+=34;

  section("Assessor / emitente");
  line("Nome:",profile?.full_name||"Assessor");
  line("Assessoria:",profile?.company_name);
  line("WhatsApp:",profile?.whatsapp||profile?.phone);

  section("Imóvel");
  line("Código:",row.property_code||"Sem anúncio vinculado");
  line("Imóvel:",row.property_title);
  line("Endereço:",row.property_address);

  section("Proprietário");
  line("Nome:",row.owner_name);
  line("Telefone:",row.owner_phone);

  if(row.client_name || row.client_phone){
    section("Cliente / inquilino");
    line("Nome:",row.client_name);
    line("Telefone:",row.client_phone);
  }

  section("Serviço");
  line("Descrição:",row.service_description);

  section("Valores");
  if(Number(row.commission_amount||0)>0) line("Comissão:",money(row.commission_amount,row.currency));
  if(Number(row.advisory_fee_amount||0)>0) line("Assessoria:",money(row.advisory_fee_amount,row.currency));
  if(Number(row.contract_amount||0)>0) line("Contrato / doc.:",money(row.contract_amount,row.currency));
  if(Number(row.other_amount||0)>0) line("Outros:",money(row.other_amount,row.currency));
  line("TOTAL:",money(receiptTotal(row),row.currency));

  section("Pagamento");
  line("Situação:",row.paid?"Valor recebido":"Pagamento pendente");
  line("Data:",row.payment_date?dateOnlyBR(row.payment_date):"—");
  line("Forma:",row.payment_method);
  line("Referência:",row.payment_reference);

  if(row.notes){
    section("Observações");
    const notes=doc.splitTextToSize(safePdfText(row.notes),width);
    doc.setFont("helvetica","normal");
    doc.setFontSize(9);
    doc.text(notes,left,y);
    y+=notes.length*4.5+4;
  }

  if(y>218){
    doc.addPage();
    y=24;
  }else{
    y=Math.max(y+10,205);
  }

  doc.setFillColor(248,249,251);
  doc.setDrawColor(210);
  doc.roundedRect(left,y,width,30,2,2,"FD");
  doc.setFont("helvetica","bold");
  doc.setFontSize(8.5);
  doc.text("DECLARAÇÃO",left+4,y+6);
  doc.setFont("helvetica","normal");
  doc.setFontSize(8);
  const declaration=row.paid
    ? `Declaro, para fins de registro, o recebimento do valor total de ${money(receiptTotal(row),row.currency)}, referente ao serviço descrito neste documento.`
    : "Este documento registra os valores e serviços informados, permanecendo o pagamento indicado como pendente.";
  doc.text(doc.splitTextToSize(declaration,width-8),left+4,y+12);
  y+=36;

  doc.setDrawColor(150);
  doc.line(left,y,left+72,y);
  doc.line(right-72,y,right,y);
  y+=5;
  doc.setFontSize(8.5);
  doc.text("Pagador / responsável",left+36,y,{align:"center"});
  doc.text("Assessor / emitente",right-36,y,{align:"center"});

  doc.setFontSize(7.5);
  doc.setTextColor(100);
  const disclaimer="Este recibo documenta as informações declaradas pelo emissor e não substitui contrato de locação, contrato de assessoria, instrumento de quitação específico ou orientação jurídica.";
  doc.text(doc.splitTextToSize(disclaimer,width),left,281);

  const code=safePdfText(row.receipt_code||"recibo").replace(/[^A-Za-z0-9_-]+/g,"-");
  doc.save(`${code}.pdf`);
}

function renderRentals(){
  const root=$("#managementRentalsList");
  if(!root) return;

  if(!rentals.length){
    root.innerHTML='<div class="empty-state"><strong>Nenhum imóvel marcado como alugado.</strong><span>Quando você usar “Marcar como alugado” em Meus anúncios, o registro aparecerá aqui.</span></div>';
    return;
  }

  root.innerHTML=`
    <div class="admin-table-wrap">
      <table class="admin-table advisor-rental-table">
        <thead><tr><th>Imóvel</th><th>Proprietário</th><th>Inquilino</th><th>Aluguel</th><th>Comissão do cliente</th><th>Assessoria</th><th>Data</th></tr></thead>
        <tbody>
          ${rentals.map(r=>`
            <tr>
              <td><strong>${escapeHTML(r.property_code||"—")}</strong><br><span class="muted">${escapeHTML(r.property_title||"Imóvel")}</span></td>
              <td><strong>${escapeHTML(r.owner_name||"—")}</strong><br><span class="muted">${escapeHTML(r.owner_phone||"")}</span></td>
              <td><strong>${escapeHTML(r.tenant_name||"—")}</strong><br><span class="muted">${escapeHTML(r.tenant_phone||"")}</span></td>
              <td>${r.monthly_rent!=null?money(r.monthly_rent,r.currency||"BRL"):"—"}<br><small>${paymentStatus(r.rent_paid,r.rent_payment_date)}</small></td>
              <td>${r.advisor_commission_charged && r.commission_amount!=null?`${money(r.commission_amount,r.currency||"BRL")}<br><small>${paymentStatus(r.commission_paid,r.advisor_commission_payment_date)}</small>`:'<span class="muted">Não cobrada</span>'}</td>
              <td>${r.had_advisory_fee && r.advisory_fee_amount!=null?`${money(r.advisory_fee_amount,r.currency||"BRL")}<br><small>${paymentStatus(r.advisory_fee_paid,r.advisory_fee_payment_date)}</small>`:'<span class="muted">Não aplicada</span>'}</td>
              <td>${dateOnlyBR(r.start_date)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAll(){
  $("#managementWelcome").textContent=profile?.company_name||profile?.full_name||"Minha gestão";
  renderOverview();
  renderOwners();
  renderFinance();
  renderReceipts();
  renderRentals();
}

function switchView(view){
  document.querySelectorAll("[data-management-view]").forEach(btn=>btn.classList.toggle("active",btn.dataset.managementView===view));
  $("#managementOverview").classList.toggle("hidden",view!=="overview");
  $("#managementOwners").classList.toggle("hidden",view!=="owners");
  $("#managementFinance").classList.toggle("hidden",view!=="finance");
  $("#managementReceipts").classList.toggle("hidden",view!=="receipts");
  $("#managementRentals").classList.toggle("hidden",view!=="rentals");
  window.scrollTo({top:0,behavior:"smooth"});
}

async function refreshAndRender(){
  await loadData();
  renderAll();
}

async function boot(){
  const bootEl=$("#managementBoot");
  const authEl=$("#managementAuth");
  const panelEl=$("#managementPanel");

  try{
    const {data,error}=await db.auth.getUser();
    const user=data?.user||null;
    if(error || !user){
      bootEl.classList.add("hidden");
      panelEl.classList.add("hidden");
      authEl.classList.remove("hidden");
      return;
    }

    const adminCheck=await db.from("admin_users").select("user_id").eq("user_id",user.id).maybeSingle();
    if(adminCheck.data){
      await db.auth.signOut();
      bootEl.classList.add("hidden");
      panelEl.classList.add("hidden");
      authEl.classList.remove("hidden");
      return;
    }

    currentUser=user;
    await loadData();
    renderAll();

    bootEl.classList.add("hidden");
    authEl.classList.add("hidden");
    panelEl.classList.remove("hidden");
  }catch(err){
    console.error("Falha ao abrir gestão:",err);
    bootEl.innerHTML=`
      <strong>Não foi possível abrir sua gestão.</strong>
      <span>${escapeHTML(err?.message||"Erro inesperado.")}</span>
      <a class="btn primary" href="assessor.html">Voltar para Área do Assessor</a>
    `;
  }
}

document.addEventListener("click",async e=>{
  const tab=e.target.closest("[data-management-view]");
  if(tab){
    switchView(tab.dataset.managementView);
    return;
  }

  if(e.target.closest("[data-close-modal]")){
    closeModal();
    return;
  }

  if(e.target.closest("[data-new-owner]")){
    ownerModal();
    return;
  }

  const editOwner=e.target.closest("[data-edit-owner]");
  if(editOwner){
    const owner=ownerById(editOwner.dataset.editOwner);
    if(owner) ownerModal(owner);
    return;
  }

  const linkOwner=e.target.closest("[data-link-owner-properties]");
  if(linkOwner){
    const owner=ownerById(linkOwner.dataset.linkOwnerProperties);
    if(owner) ownerPropertiesModal(owner);
    return;
  }

  const deleteOwner=e.target.closest("[data-delete-owner]");
  if(deleteOwner){
    const owner=ownerById(deleteOwner.dataset.deleteOwner);
    if(owner && confirm(`Excluir ${owner.full_name}? Os imóveis permanecem cadastrados, apenas sem o vínculo com este proprietário.`)){
      const {error}=await db.from("advisor_owners").delete().eq("id",owner.id).eq("advisor_id",currentUser.id);
      if(error) alert(error.message);
      else{
        await refreshAndRender();
        switchView("owners");
      }
    }
    return;
  }

  if(e.target.closest("[data-new-owner-commission]")){
    commissionModal();
    return;
  }

  const editCommission=e.target.closest("[data-edit-commission]");
  if(editCommission){
    const row=ownerCommissions.find(item=>item.id===editCommission.dataset.editCommission);
    if(row) commissionModal(row);
    return;
  }

  const markCommissionPaid=e.target.closest("[data-mark-commission-paid]");
  if(markCommissionPaid){
    await setCommissionPaid(markCommissionPaid.dataset.markCommissionPaid,true);
    return;
  }

  const markCommissionPending=e.target.closest("[data-mark-commission-pending]");
  if(markCommissionPending && confirm("Marcar esta comissão novamente como a receber?")){
    await setCommissionPaid(markCommissionPending.dataset.markCommissionPending,false);
    return;
  }

  const deleteCommission=e.target.closest("[data-delete-owner-commission]");
  if(deleteCommission && confirm("Excluir esta comissão do controle?")){
    const {error}=await db.from("advisor_owner_commissions")
      .delete()
      .eq("id",deleteCommission.dataset.deleteOwnerCommission)
      .eq("advisor_id",currentUser.id);
    if(error) alert(error.message);
    else{
      await refreshAndRender();
      switchView("finance");
    }
    return;
  }

  if(e.target.closest("[data-new-service-receipt]")){
    receiptModal();
    return;
  }

  const pdfReceipt=e.target.closest("[data-pdf-receipt]");
  if(pdfReceipt){
    const row=receipts.find(item=>item.id===pdfReceipt.dataset.pdfReceipt);
    if(row) generateServiceReceiptPdf(row);
    return;
  }

  const editReceipt=e.target.closest("[data-edit-receipt]");
  if(editReceipt){
    const row=receipts.find(item=>item.id===editReceipt.dataset.editReceipt);
    if(row) receiptModal(row);
    return;
  }

  const deleteReceipt=e.target.closest("[data-delete-receipt]");
  if(deleteReceipt && confirm("Excluir este recibo de assessoria?")){
    const {error}=await db.from("advisor_service_receipts")
      .delete()
      .eq("id",deleteReceipt.dataset.deleteReceipt)
      .eq("advisor_id",currentUser.id);
    if(error) alert(error.message);
    else{
      await refreshAndRender();
      switchView("receipts");
    }
  }
});

$("#managementModal").addEventListener("submit",async e=>{
  e.preventDefault();
  if(e.target.id==="managementOwnerPropertiesForm") await saveOwnerProperties(e.target);
  if(e.target.id==="managementCommissionForm") await saveCommission(e.target);
  if(e.target.id==="managementReceiptForm") await saveReceipt(e.target);
});

$("#managementLogout").addEventListener("click",async()=>{
  await db.auth.signOut();
  location.href="assessor.html";
});

boot();