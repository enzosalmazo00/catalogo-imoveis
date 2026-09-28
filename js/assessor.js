import { advisorDb as db, STORAGE_BUCKET } from "./config.js?v=202609282145";
import { $, escapeHTML, money, propertyTypeLabel, statusLabel } from "./common.js?v=202609281430";

let currentUser=null;
let profile=null;
let plans=[];
let subscriptions=[];
let creditBatches=[];
let properties=[];
let features=[];
let rentalControls=[];
let paymentWatcher=null;
let pendingPropertyFiles=[];
let pendingPropertyCoverExplicit=false;

function withTimeout(promise,ms=8000,label="requisição"){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" demorou mais que o esperado.")),ms);
  });
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}

function fmtDate(v){
  if(!v) return "—";
  return new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(new Date(v));
}
function validCreditBatches(){
  const now=Date.now();
  return creditBatches
    .filter(batch=>Number(batch.remaining_credits||0)>0 && !batch.revoked_at && new Date(batch.expires_at).getTime()>now)
    .sort((a,b)=>new Date(a.expires_at)-new Date(b.expires_at));
}
function creditBalance(){
  return validCreditBatches().reduce((sum,batch)=>sum+Number(batch.remaining_credits||0),0);
}
function nextCreditExpiry(){
  return validCreditBatches()[0]?.expires_at || null;
}
function canCreateAdvisorProperty(){
  return creditBalance()>0;
}
function creditExpiryDate(v){
  if(!v) return "—";
  return new Intl.DateTimeFormat("pt-BR",{dateStyle:"short"}).format(new Date(v));
}
function closeAdvisorModal(){
  if(paymentWatcher){
    clearInterval(paymentWatcher);
    paymentWatcher=null;
  }
  $("#advisorModal").classList.add("hidden");
  $("#advisorModal").innerHTML="";
}
function showAdvisorModal(html){
  $("#advisorModal").innerHTML='<div class="modal-card">'+html+'</div>';
  $("#advisorModal").classList.remove("hidden");
}

function showAdvisorPropertyPage(html){
  const page=$("#advisorPropertyPage");
  if(!page) return;
  $("#advisorPanel")?.classList.add("hidden");
  page.innerHTML='<div class="advisor-property-page-card">'+html+'</div>';
  page.classList.remove("hidden");
  window.scrollTo({top:0,behavior:"auto"});
}

function closeAdvisorPropertyPage(){
  const page=$("#advisorPropertyPage");
  if(page){
    page.classList.add("hidden");
    page.innerHTML="";
  }
  $("#advisorPanel")?.classList.remove("hidden");
  pendingPropertyFiles=[];
  pendingPropertyCoverExplicit=false;
  window.scrollTo({top:0,behavior:"auto"});
}

async function ensureProfile(user){
  const meta=user.user_metadata||{};
  const fallback={
    user_id:user.id,
    full_name:meta.full_name||user.email?.split("@")[0]||"Assessor",
    whatsapp:String(meta.whatsapp||"").replace(/\D/g,"")||null,
    phone:String(meta.phone||"").replace(/\D/g,"")||null,
    company_name:meta.company_name||null,
    city:meta.city||null,
    service_cities:["Pedro Juan Caballero","Ponta Porã"].includes(meta.city)?[meta.city]:[],
    avatar_path:null
  };

  // O banco agora cria o perfil automaticamente no cadastro.
  // O fallback evita deixar a tela travada se uma consulta estiver lenta.
  profile=fallback;

  try{
    const {data,error}=await withTimeout(
      db.from("advisor_profiles").select("*").eq("user_id",user.id).maybeSingle(),
      7000,
      "Carregamento do perfil"
    );
    if(!error && data) profile=data;
  }catch(err){
    console.warn("Perfil carregado pelos dados da sessão:",err);
  }
}

async function reconcilePendingCreditPayments(){
  const pending=subscriptions
    .filter(s=>s.status==="pending" && s.mercado_pago_payment_id)
    .slice(0,5);

  if(!pending.length) return false;

  let changed=false;
  const checks=await Promise.allSettled(
    pending.map(s=>db.functions.invoke("check-advisor-pix",{body:{subscription_id:s.id}}))
  );

  checks.forEach(result=>{
    if(result.status==="fulfilled" && result.value?.data?.status==="active") changed=true;
  });

  return changed;
}

async function loadData(){
  const results=await Promise.allSettled([
    withTimeout(
      db.from("advertising_plans").select("*").eq("active",true).order("sort_order"),
      8000,
      "Carregamento dos planos"
    ),
    withTimeout(
      db.from("advisor_subscriptions")
        .select("*, advertising_plans(*)")
        .eq("advisor_id",currentUser.id)
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento das compras"
    ),
    withTimeout(
      db.from("advisor_credit_batches")
        .select("*")
        .eq("advisor_id",currentUser.id)
        .order("expires_at",{ascending:true}),
      8000,
      "Carregamento dos créditos"
    ),
    withTimeout(
      db.from("properties")
        .select("*, property_media(*), property_features(feature_id)")
        .eq("advisor_id",currentUser.id)
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento dos anúncios"
    ),
    withTimeout(
      db.from("features")
        .select("*")
        .eq("active",true)
        .order("category")
        .order("sort_order"),
      8000,
      "Carregamento das opções do imóvel"
    ),
    withTimeout(
      db.from("advisor_rental_control")
        .select("*")
        .eq("advisor_id",currentUser.id)
        .order("status",{ascending:true})
        .order("start_date",{ascending:false}),
      8000,
      "Carregamento do controle de locações"
    )
  ]);

  const [plRes,subRes,creditRes,adsRes,featuresRes,rentalRes]=results;
  plans=plRes.status==="fulfilled"?(plRes.value.data||[]):[];
  subscriptions=subRes.status==="fulfilled"?(subRes.value.data||[]):[];
  creditBatches=creditRes.status==="fulfilled"?(creditRes.value.data||[]):[];
  properties=adsRes.status==="fulfilled"?(adsRes.value.data||[]):[];
  features=featuresRes.status==="fulfilled"?(featuresRes.value.data||[]):[];
  rentalControls=rentalRes.status==="fulfilled"?(rentalRes.value.data||[]):[];

  try{
    const changed=await reconcilePendingCreditPayments();
    if(changed){
      const [subReload,creditReload]=await Promise.all([
        db.from("advisor_subscriptions")
          .select("*, advertising_plans(*)")
          .eq("advisor_id",currentUser.id)
          .order("created_at",{ascending:false}),
        db.from("advisor_credit_batches")
          .select("*")
          .eq("advisor_id",currentUser.id)
          .order("expires_at",{ascending:true})
      ]);
      subscriptions=subReload.data||subscriptions;
      creditBatches=creditReload.data||creditBatches;
    }
  }catch(err){
    console.warn("Não foi possível reconciliar pagamentos pendentes:",err);
  }

  const failures=results.filter(r=>r.status==="rejected");
  if(failures.length){
    console.warn("Alguns dados do painel demoraram para carregar:",failures);
  }

  return failures.length===0;
}

function renderPlans(){
  $("#advisorPlans").innerHTML=plans.map(plan=>{
    const unit=Number(plan.price)/Math.max(1,Number(plan.ad_limit||1));
    return `
      <article class="advisor-plan-card">
        <span class="advisor-plan-badge">${plan.ad_limit} crédito${plan.ad_limit>1?"s":""}</span>
        <h3>${escapeHTML(plan.name)}</h3>
        <div class="advisor-plan-price">${money(plan.price,"BRL")}</div>
        <div class="advisor-plan-unit">${money(unit,"BRL")} por crédito</div>
        <p>Créditos não usados válidos por <strong>90 dias</strong> após a compra.</p>
        <small>Cada crédito publicado ativa 1 imóvel por 30 dias.</small>
        <button class="btn primary full" data-buy="${plan.id}">Comprar créditos via PIX</button>
      </article>`;
  }).join("");
}

function renderCreditWallet(){
  const usable=validCreditBatches();
  const purchasedBalance=usable
    .filter(batch=>(batch.source||"purchase")==="purchase")
    .reduce((sum,batch)=>sum+Number(batch.remaining_credits||0),0);
  const bonusBalance=usable
    .filter(batch=>batch.source==="bonus")
    .reduce((sum,batch)=>sum+Number(batch.remaining_credits||0),0);
  const balance=purchasedBalance+bonusBalance;

  const purchasedCoins=Array.from({length:purchasedBalance},(_,i)=>
    `<span class="advisor-credit-coin" title="Crédito comprado disponível">${i+1}</span>`
  ).join("");
  const bonusCoins=bonusBalance>0
    ? '<span class="advisor-credit-coin bonus" title="Créditos bônus para anúncio">🎁</span>'
    : "";

  const nextExpiry=nextCreditExpiry();
  const activeListings=properties.filter(
    p=>p.listing_expires_at && new Date(p.listing_expires_at)>new Date() && p.is_published
  ).length;

  $("#advisorCreditBalance").textContent=String(balance);
  $("#advisorCreditLabel").textContent=balance===1?"crédito disponível":"créditos disponíveis";
  $("#advisorCreditCoins").innerHTML=balance
    ? purchasedCoins+bonusCoins
    : '<span class="advisor-credit-zero">Saldo zerado</span>';

  const purchasedEl=$("#advisorPurchasedCredits");
  const bonusEl=$("#advisorBonusCredits");
  const bonusBox=$("#advisorBonusCreditBox");

  if(purchasedEl) purchasedEl.textContent=String(purchasedBalance);
  if(bonusEl) bonusEl.textContent=String(bonusBalance);
  if(bonusBox) bonusBox.classList.toggle("hidden",bonusBalance<=0);

  $("#advisorCreditMeta").textContent=nextExpiry
    ? `Próximo vencimento de crédito não usado: ${creditExpiryDate(nextExpiry)} • ${activeListings} anúncio${activeListings===1?"":"s"} ativo${activeListings===1?"":"s"}`
    : `Nenhum crédito disponível • ${activeListings} anúncio${activeListings===1?"":"s"} ativo${activeListings===1?"":"s"}`;
}

function renderExpiredNotice(){
  const expired=properties.filter(p=>p.listing_expires_at && new Date(p.listing_expires_at)<=new Date());
  const box=$("#advisorExpiredNotice");
  if(!expired.length){box.innerHTML="";return;}

  const balance=creditBalance();
  box.innerHTML=`<div class="advisor-expired-alert">
    <strong>${expired.length} anúncio${expired.length>1?"s expiraram":" expirou"}.</strong>
    <span>${balance>0
      ? "Use 1 crédito para reativar cada imóvel por mais 30 dias."
      : "Eles estão fora do catálogo. Compre créditos para reativá-los."}</span>
  </div>`;
}

function renderAds(){
  if(!properties.length){
    $("#advisorAds").innerHTML='<div class="empty-state"><strong>Nenhum anúncio publicado ainda.</strong><span>Compre créditos e use 1 crédito para ativar seu primeiro imóvel por 30 dias.</span></div>';
    return;
  }

  const balance=creditBalance();

  $("#advisorAds").innerHTML=`
    <div class="advisor-ad-list">
      ${properties.map(p=>{
        const expired=!p.listing_expires_at || new Date(p.listing_expires_at)<=new Date() || !p.is_published;
        return `
          <div class="advisor-ad-row">
            <div>
              <strong>${escapeHTML(p.title)}</strong>
              <span>${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))}</span>
              <small>${expired?"Expirado":"Ativo"} • publicado em: ${fmtDate(p.listing_started_at||p.created_at)} • válido até: ${fmtDate(p.listing_expires_at)}</small>
              <small class="listing-code">Código do imóvel: ${escapeHTML(p.public_code||"—")}</small>
            </div>
            <div class="advisor-ad-actions">
              <span class="pill ${expired?"pending":"paid"}">${expired?"FORA DO AR":"ATIVO"}</span>
              ${expired
                ? (balance>0
                    ? `<button class="btn primary compact" data-reactivate-ad="${p.id}">Reativar • 1 crédito</button>`
                    : '<button class="btn ghost compact" type="button" disabled>Sem crédito para reativar</button>')
                : `<button class="btn ghost compact" data-edit-ad="${p.id}">Editar</button>`
              }
              <button class="btn danger compact" data-delete-ad="${p.id}">Excluir</button>
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

function advisorAvatarUrl(path){
  if(!path) return "";
  return db.storage.from("advisor-avatars").getPublicUrl(path).data.publicUrl || "";
}

function advisorInitials(){
  const name=String(profile?.company_name || profile?.full_name || "Assessor").trim();
  return name.split(/\s+/).slice(0,2).map(p=>p[0]||"").join("").toUpperCase() || "A";
}

function renderAdvisorAvatar(){
  const el=$("#advisorAvatar");
  if(!el) return;

  const url=advisorAvatarUrl(profile?.avatar_path);

  if(!url){
    el.textContent="";
    el.style.backgroundImage="";
    el.classList.remove("has-photo");
    el.classList.add("hidden");
    return;
  }

  el.textContent="";
  el.style.backgroundImage=`url("${url.replace(/"/g,"%22")}")`;
  el.classList.add("has-photo");
  el.classList.remove("hidden");
}

function dateOnlyBR(v){
  if(!v) return "—";
  const [y,m,d]=String(v).slice(0,10).split("-");
  return y&&m&&d?`${d}/${m}/${y}`:"—";
}

function renderRentalControl(){
  const root=$("#advisorRentalControlList");
  if(!root) return;

  const active=rentalControls.filter(r=>r.status==="active");
  const activeRent=active.reduce((sum,r)=>sum+Number(r.monthly_rent||0),0);
  const commissionPending=active
    .filter(r=>!r.commission_paid)
    .reduce((sum,r)=>sum+Number(r.commission_amount||0),0);

  const rows=rentalControls.map(r=>`
    <tr>
      <td><strong>${escapeHTML(r.property_code||"—")}</strong><br><span class="muted">${escapeHTML(r.property_title||"Imóvel não vinculado")}</span></td>
      <td><strong>${escapeHTML(r.owner_name||"—")}</strong><br><span class="muted">${escapeHTML(r.owner_phone||"")}</span></td>
      <td><strong>${escapeHTML(r.tenant_name||"—")}</strong><br><span class="muted">${escapeHTML(r.tenant_phone||"")}</span></td>
      <td>${r.monthly_rent!=null?money(r.monthly_rent,r.currency):"—"}</td>
      <td>${r.security_deposit!=null?money(r.security_deposit,r.currency):"—"}<br><small>${r.security_deposit_paid?"Pago":"Pendente"}</small></td>
      <td>${r.commission_amount!=null?money(r.commission_amount,r.currency):"—"}<br><small>${r.commission_paid?"Paga":"Pendente"}</small></td>
      <td>${dateOnlyBR(r.start_date)}<br><small>Venc.: dia ${r.rent_due_day||"—"}</small></td>
      <td><span class="pill ${r.status==="active"?"paid":"pending"}">${r.status==="active"?"ATIVA":"ENCERRADA"}</span></td>
      <td>
        <div class="table-actions">
          <button class="btn ghost compact" type="button" data-edit-rental-control="${r.id}">Editar</button>
          <button class="btn danger compact" type="button" data-delete-rental-control="${r.id}">Excluir</button>
        </div>
      </td>
    </tr>
  `).join("");

  root.innerHTML=`
    <div class="advisor-rental-summary">
      <div><span>Locações ativas</span><strong>${active.length}</strong></div>
      <div><span>Aluguel mensal sob controle</span><strong>${money(activeRent,"BRL")}</strong></div>
      <div><span>Comissões pendentes*</span><strong>${money(commissionPending,"BRL")}</strong></div>
    </div>
    <p class="tiny-note">*O resumo financeiro soma os valores registrados em real. Registros em guarani continuam visíveis individualmente na planilha.</p>
    ${rows?`
      <div class="admin-table-wrap advisor-rental-table-wrap">
        <table class="admin-table advisor-rental-table">
          <thead><tr><th>Imóvel</th><th>Proprietário</th><th>Inquilino</th><th>Aluguel</th><th>Caução</th><th>Comissão</th><th>Início</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `:'<div class="empty-state"><strong>Nenhuma locação registrada.</strong><span>Use esta planilha para seu controle particular de imóveis alugados.</span></div>'}
  `;
}

function rentalControlModal(row=null){
  const propertyOptions=properties.map(p=>`
    <option value="${p.id}" ${row?.property_id===p.id?"selected":""}>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</option>
  `).join("");

  showAdvisorModal(`
    <div class="modal-head">
      <div><p class="eyebrow">CONTROLE PRIVADO</p><h2>${row?"Editar":"Registrar"} locação</h2></div>
      <button class="icon-btn" type="button" data-close>✕</button>
    </div>
    <form id="advisorRentalControlForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">

      <label class="span-2">Imóvel
        <select name="property_id">
          <option value="">Não vincular a um anúncio</option>
          ${propertyOptions}
        </select>
      </label>

      <div class="form-section-title property-section-title">Proprietário e inquilino</div>
      <label>Nome do proprietário<input name="owner_name" value="${escapeHTML(row?.owner_name||"")}"></label>
      <label>Telefone do proprietário<input name="owner_phone" inputmode="tel" value="${escapeHTML(row?.owner_phone||"")}"></label>
      <label>Nome do inquilino<input name="tenant_name" required value="${escapeHTML(row?.tenant_name||"")}"></label>
      <label>Telefone do inquilino<input name="tenant_phone" inputmode="tel" value="${escapeHTML(row?.tenant_phone||"")}"></label>

      <div class="form-section-title property-section-title">Valores</div>
      <label>Moeda
        <select name="currency">
          <option value="BRL" ${(row?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${row?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>
      <label>Aluguel mensal<input name="monthly_rent" type="number" min="0" step="1" value="${row?.monthly_rent??""}"></label>
      <label>Valor da caução<input name="security_deposit" type="number" min="0" step="1" value="${row?.security_deposit??""}"></label>
      <label>Caução paga?
        <select name="security_deposit_paid"><option value="false" ${!row?.security_deposit_paid?"selected":""}>Não</option><option value="true" ${row?.security_deposit_paid?"selected":""}>Sim</option></select>
      </label>
      <label>Comissão do assessor<input name="commission_amount" type="number" min="0" step="1" value="${row?.commission_amount??""}"></label>
      <label>Comissão paga?
        <select name="commission_paid"><option value="false" ${!row?.commission_paid?"selected":""}>Não</option><option value="true" ${row?.commission_paid?"selected":""}>Sim</option></select>
      </label>
      <label>Taxa de assessoria<input name="advisory_fee_amount" type="number" min="0" step="1" value="${row?.advisory_fee_amount??""}"></label>
      <label>Taxa de assessoria paga?
        <select name="advisory_fee_paid"><option value="false" ${!row?.advisory_fee_paid?"selected":""}>Não</option><option value="true" ${row?.advisory_fee_paid?"selected":""}>Sim</option></select>
      </label>

      <div class="form-section-title property-section-title">Período e controle</div>
      <label>Início da locação<input name="start_date" type="date" value="${row?.start_date||""}"></label>
      <label>Fim / término<input name="end_date" type="date" value="${row?.end_date||""}"></label>
      <label>Dia de vencimento do aluguel<input name="rent_due_day" type="number" min="1" max="31" value="${row?.rent_due_day??""}"></label>
      <label>Status
        <select name="status"><option value="active" ${row?.status!=="ended"?"selected":""}>Ativa</option><option value="ended" ${row?.status==="ended"?"selected":""}>Encerrada</option></select>
      </label>
      <label class="span-2">Observações<textarea name="notes" rows="4">${escapeHTML(row?.notes||"")}</textarea></label>

      <div id="advisorRentalControlMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar na planilha</button>
      </div>
    </form>
  `);
}

async function saveRentalControl(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const propertyId=String(fd.get("property_id")||"").trim()||null;
  const property=propertyId?properties.find(p=>p.id===propertyId):null;
  const msg=form.querySelector("#advisorRentalControlMessage");
  const n=v=>String(v??"").trim()===""?null:Number(v);

  const row={
    advisor_id:currentUser.id,
    property_id:propertyId,
    property_code:property?.public_code||null,
    property_title:property?.title||null,
    owner_name:String(fd.get("owner_name")||"").trim()||null,
    owner_phone:String(fd.get("owner_phone")||"").trim()||null,
    tenant_name:String(fd.get("tenant_name")||"").trim(),
    tenant_phone:String(fd.get("tenant_phone")||"").trim()||null,
    currency:fd.get("currency")||"BRL",
    monthly_rent:n(fd.get("monthly_rent")),
    security_deposit:n(fd.get("security_deposit")),
    security_deposit_paid:fd.get("security_deposit_paid")==="true",
    commission_amount:n(fd.get("commission_amount")),
    commission_paid:fd.get("commission_paid")==="true",
    advisory_fee_amount:n(fd.get("advisory_fee_amount")),
    advisory_fee_paid:fd.get("advisory_fee_paid")==="true",
    start_date:fd.get("start_date")||null,
    end_date:fd.get("end_date")||null,
    rent_due_day:n(fd.get("rent_due_day")),
    status:fd.get("status")||"active",
    notes:String(fd.get("notes")||"").trim()||null
  };

  if(!row.tenant_name){
    if(msg) msg.textContent="Informe o nome do inquilino.";
    return;
  }

  const result=id
    ? await db.from("advisor_rental_control").update(row).eq("id",id).eq("advisor_id",currentUser.id)
    : await db.from("advisor_rental_control").insert(row);

  if(result.error){
    if(msg) msg.textContent=result.error.message;
    return;
  }

  const reload=await db.from("advisor_rental_control").select("*").eq("advisor_id",currentUser.id).order("status",{ascending:true}).order("start_date",{ascending:false});
  rentalControls=reload.data||[];
  closeAdvisorModal();
  renderRentalControl();
}

function renderPanel(){
  $("#advisorWelcome").textContent=profile?.company_name || profile?.full_name || "Meus anúncios";
  renderAdvisorAvatar();
  renderCreditWallet();
  renderExpiredNotice();
  renderPlans();
  renderAds();
  renderRentalControl();

  const newBtn=$("#newAdvisorProperty");
  if(newBtn){
    const balance=creditBalance();
    if(balance>0){
      newBtn.disabled=false;
      newBtn.textContent="+ Novo anúncio";
      newBtn.title="A publicação consumirá 1 crédito.";
    }else{
      newBtn.disabled=true;
      newBtn.textContent="Saldo de créditos zerado";
      newBtn.title="Compre créditos para publicar um novo imóvel.";
    }
  }
}

function advisorProfileModal(){
  const cities=Array.isArray(profile?.service_cities)?profile.service_cities:[];
  const pjcChecked=cities.includes("Pedro Juan Caballero") || (!cities.length && profile?.city==="Pedro Juan Caballero");
  const ppChecked=cities.includes("Ponta Porã") || (!cities.length && profile?.city==="Ponta Porã");

  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">MEU PERFIL</p>
        <h2>Dados do assessor</h2>
        <p class="muted property-form-lead">Atualize seus dados de contato, cidades de atuação e senha.</p>
      </div>
      <button class="icon-btn" data-close>✕</button>
    </div>

    <form id="advisorProfileForm" class="form-grid advisor-profile-form">
      <div class="form-section-title property-section-title">Foto de perfil</div>
      <div class="span-2 advisor-avatar-editor">
        <div id="advisorAvatarPreview" class="advisor-avatar advisor-avatar-large">${profile?.avatar_path ? "" : "👤"}</div>
        <div class="advisor-avatar-upload">
          <label>Escolher foto
            <input name="avatar" type="file" accept="image/jpeg,image/png,image/webp,image/avif">
          </label>
          <small>JPG, PNG, WEBP ou AVIF. Máximo de 5 MB.</small>
        </div>
      </div>

      <div class="form-section-title property-section-title">Dados pessoais e profissionais</div>

      <label>Nome completo
        <input name="full_name" required value="${escapeHTML(profile?.full_name||"")}">
      </label>

      <label>Nome da assessoria / empresa
        <input name="company_name" value="${escapeHTML(profile?.company_name||"")}" placeholder="Ex.: AF Assessoria">
      </label>

      <label>WhatsApp
        <input name="whatsapp" inputmode="tel" required value="${escapeHTML(profile?.whatsapp||"")}" placeholder="Ex.: 595981123456">
      </label>

      <label>Telefone
        <input name="phone" inputmode="tel" value="${escapeHTML(profile?.phone||"")}" placeholder="Ex.: 6734321234">
      </label>

      <label class="span-2">E-mail da conta
        <input value="${escapeHTML(currentUser?.email||"")}" readonly class="readonly-input">
        <small>O e-mail de acesso não é alterado por esta tela.</small>
      </label>

      <div class="form-section-title property-section-title">Cidades onde atua</div>
      <div class="span-2 advisor-city-options">
        <label class="check-chip property-option-chip">
          <input type="checkbox" name="service_cities" value="Pedro Juan Caballero" ${pjcChecked?"checked":""}>
          <span>Pedro Juan Caballero</span>
        </label>
        <label class="check-chip property-option-chip">
          <input type="checkbox" name="service_cities" value="Ponta Porã" ${ppChecked?"checked":""}>
          <span>Ponta Porã</span>
        </label>
      </div>
      <div class="span-2 property-options-help">Você pode marcar as duas cidades.</div>

      <div class="form-section-title property-section-title">Alterar senha</div>
      <div class="span-2 profile-password-note">Deixe os campos abaixo vazios se não quiser alterar a senha.</div>

      <label>Senha atual
        <input name="current_password" type="password" autocomplete="current-password" minlength="6">
      </label>

      <label>Nova senha
        <input name="new_password" type="password" autocomplete="new-password" minlength="6">
      </label>

      <label>Confirmar nova senha
        <input name="confirm_password" type="password" autocomplete="new-password" minlength="6">
      </label>

      <div></div>

      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar perfil</button>
      </div>
      <div id="advisorProfileMessage" class="span-2 form-message"></div>
    </form>
  `);

  const preview=$("#advisorAvatarPreview");
  if(preview){
    const currentUrl=advisorAvatarUrl(profile?.avatar_path);
    if(currentUrl){
      preview.textContent="";
      preview.style.backgroundImage=`url("${currentUrl.replace(/"/g,"%22")}")`;
      preview.classList.add("has-photo");
    }

    form.querySelector('input[name="avatar"]')?.addEventListener("change",e=>{
      const file=e.target.files?.[0];
      if(!file) return;
      if(file.size>5*1024*1024){
        e.target.value="";
        alert("A foto deve ter no máximo 5 MB.");
        return;
      }
      const local=URL.createObjectURL(file);
      preview.textContent="";
      preview.style.backgroundImage=`url("${local}")`;
      preview.classList.add("has-photo");
    });
  }
}

async function saveAdvisorProfile(form){
  const fd=new FormData(form);
  const msg=$("#advisorProfileMessage");

  const fullName=String(fd.get("full_name")||"").trim();
  const companyName=String(fd.get("company_name")||"").trim()||null;
  const whatsapp=String(fd.get("whatsapp")||"").replace(/\D/g,"")||null;
  const phone=String(fd.get("phone")||"").replace(/\D/g,"")||null;
  const cities=[...form.querySelectorAll('input[name="service_cities"]:checked')].map(el=>el.value);

  if(!fullName){
    msg.textContent="Informe seu nome completo.";
    return;
  }
  if(!whatsapp){
    msg.textContent="Informe seu WhatsApp.";
    return;
  }
  if(!cities.length){
    msg.textContent="Selecione pelo menos uma cidade onde você atua.";
    return;
  }

  const currentPassword=String(fd.get("current_password")||"");
  const newPassword=String(fd.get("new_password")||"");
  const confirmPassword=String(fd.get("confirm_password")||"");
  const wantsPasswordChange=currentPassword || newPassword || confirmPassword;

  if(wantsPasswordChange){
    if(!currentPassword || !newPassword || !confirmPassword){
      msg.textContent="Para alterar a senha, preencha senha atual, nova senha e confirmação.";
      return;
    }
    if(newPassword.length<6){
      msg.textContent="A nova senha deve ter pelo menos 6 caracteres.";
      return;
    }
    if(newPassword!==confirmPassword){
      msg.textContent="A confirmação da nova senha não confere.";
      return;
    }
  }

  msg.textContent="Salvando perfil...";

  const avatarFile=form.querySelector('input[name="avatar"]')?.files?.[0] || null;
  let avatarPath=profile?.avatar_path || null;
  let uploadedAvatarPath=null;

  if(avatarFile){
    if(avatarFile.size>5*1024*1024){
      msg.textContent="A foto deve ter no máximo 5 MB.";
      return;
    }

    const ext=(avatarFile.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"") || "jpg";
    uploadedAvatarPath=`${currentUser.id}/avatar-${crypto.randomUUID()}.${ext}`;

    msg.textContent="Enviando foto...";
    const upload=await db.storage.from("advisor-avatars").upload(uploadedAvatarPath,avatarFile,{
      cacheControl:"3600",
      upsert:false
    });

    if(upload.error){
      msg.textContent="Não foi possível enviar a foto: "+upload.error.message;
      return;
    }

    avatarPath=uploadedAvatarPath;
  }

  const profileRow={
    full_name:fullName,
    company_name:companyName,
    whatsapp,
    phone,
    service_cities:cities,
    city:cities.length===1?cities[0]:null,
    avatar_path:avatarPath,
    updated_at:new Date().toISOString()
  };

  const {data:updated,error:profileError}=await db
    .from("advisor_profiles")
    .upsert({
      user_id:currentUser.id,
      ...profileRow
    },{onConflict:"user_id"})
    .select("*")
    .single();

  if(profileError){
    if(uploadedAvatarPath) await db.storage.from("advisor-avatars").remove([uploadedAvatarPath]);
    msg.textContent=profileError.message;
    return;
  }

  if(uploadedAvatarPath && profile?.avatar_path && profile.avatar_path!==uploadedAvatarPath){
    await db.storage.from("advisor-avatars").remove([profile.avatar_path]);
  }

  const {error:metaError}=await db.auth.updateUser({
    data:{
      full_name:fullName,
      company_name:companyName||"",
      whatsapp:whatsapp||"",
      phone:phone||"",
      city:cities.length===1?cities[0]:""
    }
  });

  if(metaError){
    msg.textContent="Perfil salvo, mas não foi possível atualizar os dados da sessão: "+metaError.message;
    profile=updated;
    renderPanel();
    return;
  }

  if(wantsPasswordChange){
    msg.textContent="Confirmando sua senha atual...";
    const {error:reauthError}=await db.auth.signInWithPassword({
      email:currentUser.email,
      password:currentPassword
    });

    if(reauthError){
      profile=updated;
      renderPanel();
      msg.textContent="Os dados do perfil foram salvos, mas a senha atual informada está incorreta.";
      return;
    }

    msg.textContent="Alterando senha...";
    const {error:passwordError}=await db.auth.updateUser({password:newPassword});
    if(passwordError){
      profile=updated;
      renderPanel();
      msg.textContent="Os dados do perfil foram salvos, mas não foi possível alterar a senha: "+passwordError.message;
      return;
    }
  }

  profile=updated;
  renderPanel();
  msg.textContent=wantsPasswordChange?"Perfil e senha atualizados com sucesso.":"Perfil atualizado com sucesso.";

  setTimeout(()=>closeAdvisorModal(),900);
}

function countOptions(value,max=10){
  return Array.from({length:max+1},(_,i)=>
    `<option value="${i}" ${Number(value??0)===i?"selected":""}>${i}</option>`
  ).join("");
}

function featureChips(category,selectedIds=[]){
  return features
    .filter(f=>f.category===category)
    .map(f=>`
      <label class="check-chip property-option-chip">
        <input type="checkbox" name="features" value="${f.id}" ${selectedIds.includes(f.id)?"checked":""}>
        <span>${escapeHTML(f.name)}</span>
      </label>`
    ).join("");
}

function propertyMediaPublicUrl(path){
  if(!path) return "";
  return db.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl || "";
}

function sortedPropertyImages(property){
  return [...(property?.property_media||[])]
    .filter(m=>m.media_type==="image")
    .sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));
}

function propertyYoutubeMedia(property){
  return (property?.property_media||[]).find(m=>m.media_type==="youtube") || null;
}

function existingPropertyMediaHtml(property){
  const images=sortedPropertyImages(property);
  const video=propertyYoutubeMedia(property);
  if(!images.length && !video) return "";
  let html='<div class="span-2 current-property-media"><div class="property-options-help"><strong>🔒 Mídias fixas deste imóvel.</strong> Você pode trocar a foto principal e reorganizar a ordem, mas não adicionar, excluir ou substituir fotos/vídeo depois da publicação.</div><div class="property-media-editor-grid">';
  images.forEach((m,index)=>{
    html+='<div class="property-media-editor-item'+(m.is_cover?' cover':'')+'">';
    html+='<div class="property-media-order">Foto '+(index+1)+'</div>';
    html+='<img src="'+escapeHTML(propertyMediaPublicUrl(m.storage_path))+'" alt="">';
    if(m.is_cover) html+='<span class="media-cover-badge">PRINCIPAL</span>';
    html+='<div class="property-media-editor-actions">';
    html+='<button type="button" class="btn ghost compact" data-media-left="'+m.id+'" data-property="'+property.id+'"'+(index===0?' disabled':'')+'>←</button>';
    html+='<button type="button" class="btn ghost compact" data-media-cover="'+m.id+'" data-property="'+property.id+'">Capa</button>';
    html+='<button type="button" class="btn ghost compact" data-media-right="'+m.id+'" data-property="'+property.id+'"'+(index===images.length-1?' disabled':'')+'>→</button>';
    html+='</div></div>';
  });
  if(video){
    html+='<div class="property-media-editor-item video-media-item"><div class="property-media-order">Vídeo fixo</div><div class="video-media-placeholder">▶</div><div class="property-media-editor-actions one-action"><span class="tiny-note">🔒 Não pode ser substituído</span></div></div>';
  }
  html+='</div></div>';
  return html;
}

function renderPendingPropertyPhotos(){
  const box=$("#pendingPropertyPhotos");
  if(!box) return;
  box.innerHTML="";
  if(!pendingPropertyFiles.length){
    box.innerHTML='<div class="media-empty-note">Nenhuma foto nova selecionada.</div>';
    return;
  }
  pendingPropertyFiles.forEach((file,index)=>{
    const card=document.createElement("div");
    card.className="property-media-editor-item"+(index===0?" cover":"");
    const url=URL.createObjectURL(file);
    card.innerHTML='<div class="property-media-order">Foto '+(index+1)+'</div>'+
      '<img src="'+url+'" alt="Prévia da foto">'+
      (index===0?'<span class="media-cover-badge">'+(pendingPropertyCoverExplicit?"PRINCIPAL":"FOTO 1")+'</span>':'')+
      '<div class="property-media-editor-actions">'+
      '<button type="button" class="btn ghost compact" data-pending-left="'+index+'"'+(index===0?' disabled':'')+'>←</button>'+
      '<button type="button" class="btn ghost compact" data-pending-cover="'+index+'">Capa</button>'+
      '<button type="button" class="btn ghost compact" data-pending-right="'+index+'"'+(index===pendingPropertyFiles.length-1?' disabled':'')+'>→</button>'+
      '<button type="button" class="btn danger compact" data-pending-remove="'+index+'">Excluir</button>'+
      '</div>';
    box.appendChild(card);
  });
}

function existingAdvisorMediaHTML(property){
  const media=[...(property?.property_media||[])].sort((a,b)=>{
    if(a.media_type==="image" && b.media_type==="image"){
      return Number(b.is_cover)-Number(a.is_cover) || Number(a.sort_order||0)-Number(b.sort_order||0);
    }
    if(a.media_type==="image") return -1;
    if(b.media_type==="image") return 1;
    return Number(a.sort_order||0)-Number(b.sort_order||0);
  });

  if(!media.length) return "";

  return `
    <div class="span-2 advisor-media-existing">
      <strong>Mídias já publicadas</strong>
      <div class="advisor-media-grid">
        ${media.map((m,index)=>{
          if(m.media_type==="image"){
            const url=db.storage.from(STORAGE_BUCKET).getPublicUrl(m.storage_path).data.publicUrl;
            return `
              <article class="advisor-media-card">
                <div class="advisor-media-preview">
                  <img src="${escapeHTML(url)}" alt="">
                  <span class="media-order-badge">${m.is_cover?"CAPA":`Foto ${index+1}`}</span>
                </div>
                <div class="advisor-media-card-actions">
                  ${m.is_cover?'<strong>Foto principal ✓</strong>':`<button type="button" class="media-mini-btn" data-advisor-cover="${m.id}" data-property="${property.id}">Definir como capa</button>`}
                  <div class="media-move-row">
                    <button type="button" class="media-mini-btn" data-media-move="-1" data-media-id="${m.id}" data-property="${property.id}" aria-label="Mover foto para antes">←</button>
                    <button type="button" class="media-mini-btn" data-media-move="1" data-media-id="${m.id}" data-property="${property.id}" aria-label="Mover foto para depois">→</button>
                    <button type="button" class="media-mini-btn danger" data-advisor-delete-media="${m.id}" data-property="${property.id}">Excluir</button>
                  </div>
                </div>
              </article>`;
          }
          return `
            <article class="advisor-media-card">
              <div class="advisor-video-placeholder">▶<span>Vídeo</span></div>
              <div class="advisor-media-card-actions">
                <strong>Vídeo do imóvel</strong>
                <button type="button" class="media-mini-btn danger" data-advisor-delete-media="${m.id}" data-property="${property.id}">Excluir vídeo</button>
              </div>
            </article>`;
        }).join("")}
      </div>
      <small>Use as setas para definir a sequência Foto 1, Foto 2, Foto 3... A capa é sempre a imagem principal do catálogo.</small>
    </div>`;
}

function setupNewMediaPreview(){ /* seletor múltiplo removido para compatibilidade com Safari iOS */ }

function propertyDraftKey(property){
  return property?.id ? `edit:${property.id}` : "new";
}

function collectPropertyDraft(form){
  const data={};
  const featureIds=[];

  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el=>{
    if(el.type==="file") return;
    if(el.name==="features"){
      if(el.checked) featureIds.push(el.value);
      return;
    }
    if(el.type==="checkbox"){
      data[el.name]=!!el.checked;
      return;
    }
    data[el.name]=el.value;
  });

  data.features=featureIds;
  return data;
}

function applyPropertyDraft(form,data){
  if(!data || typeof data!=="object") return;

  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el=>{
    if(el.type==="file" || el.name==="id") return;

    if(el.name==="features"){
      const selected=Array.isArray(data.features)?data.features:[];
      el.checked=selected.includes(el.value);
      return;
    }

    if(!(el.name in data)) return;

    if(el.type==="checkbox"){
      el.checked=!!data[el.name];
    }else{
      el.value=data[el.name]??"";
    }
  });
}

async function loadPropertyDraft(form,property){
  if(!currentUser || !form) return;
  const draftKey=propertyDraftKey(property);
  form.dataset.draftKey=draftKey;

  const status=form.querySelector("#propertyDraftStatus");
  const {data,error}=await db.from("advisor_property_drafts")
    .select("draft_data,updated_at")
    .eq("advisor_id",currentUser.id)
    .eq("draft_key",draftKey)
    .maybeSingle();

  if(error){
    console.warn("Não foi possível consultar o rascunho:",error);
    return;
  }

  if(data?.draft_data){
    applyPropertyDraft(form,data.draft_data);
    wirePropertyTechnicalFields(form);
    if(status){
      status.innerHTML=`<strong>Rascunho recuperado ✓</strong><span>Salvo em ${fmtDate(data.updated_at)}. Fotos precisam ser selecionadas novamente.</span>`;
      status.classList.remove("hidden");
    }
  }
}

async function savePropertyDraft(form){
  if(!currentUser || !form) return;
  const status=form.querySelector("#propertyDraftStatus");
  const draftKey=form.dataset.draftKey || propertyDraftKey(null);

  if(status){
    status.innerHTML="<strong>Salvando rascunho...</strong>";
    status.classList.remove("hidden");
  }

  const {error}=await db.from("advisor_property_drafts").upsert({
    advisor_id:currentUser.id,
    draft_key:draftKey,
    draft_data:collectPropertyDraft(form)
  },{onConflict:"advisor_id,draft_key"});

  if(error){
    if(status) status.innerHTML=`<strong>Não foi possível salvar.</strong><span>${escapeHTML(error.message)}</span>`;
    return;
  }

  if(status){
    status.innerHTML="<strong>Rascunho salvo ✓</strong><span>Você pode sair e continuar depois. As fotos precisam ser escolhidas novamente quando voltar.</span>";
  }
}

async function deletePropertyDraft(form,{silent=false}={}){
  if(!currentUser || !form) return true;
  const draftKey=form.dataset.draftKey || propertyDraftKey(null);
  const status=form.querySelector("#propertyDraftStatus");

  const {error}=await db.from("advisor_property_drafts")
    .delete()
    .eq("advisor_id",currentUser.id)
    .eq("draft_key",draftKey);

  if(error){
    if(!silent && status){
      status.innerHTML=`<strong>Não foi possível excluir o rascunho.</strong><span>${escapeHTML(error.message)}</span>`;
      status.classList.remove("hidden");
    }
    return false;
  }

  if(!silent && status){
    status.innerHTML="<strong>Rascunho excluído.</strong><span>Os campos atuais continuam na tela até você fechar ou publicar.</span>";
    status.classList.remove("hidden");
  }
  return true;
}

function wirePropertyTechnicalFields(form){
  if(!form) return;

  const update=()=>{
    const type=form.querySelector('[name="property_type"]')?.value;
    const housing=form.querySelector('[name="housing_context"]')?.value;
    const garage=form.querySelector('[name="garage_scope"]')?.value;
    const hasAdvisoryFee=form.querySelector('[name="has_advisory_fee"]')?.value==="true";

    form.querySelector("#distributionFields")?.classList.toggle("hidden",type==="monoambiente");
    form.querySelector("#condominiumNameField")?.classList.toggle("hidden",housing!=="condominium");
    form.querySelector("#garageDetails")?.classList.toggle("hidden",garage==="none");
    form.querySelector("#advisorAdvisoryFeeField")?.classList.toggle("hidden",!hasAdvisoryFee);

    const advisoryInput=form.querySelector('[name="advisory_fee"]');
    if(advisoryInput) advisoryInput.required=hasAdvisoryFee;
  };

  ["property_type","housing_context","garage_scope","has_advisory_fee"].forEach(name=>{
    form.querySelector(`[name="${name}"]`)?.addEventListener("change",update);
  });
  update();
}

function applyPublishedPropertyEditLock(form,property){
  if(!form || !property) return;

  const lockedNames=[
    "title","property_type","bedrooms","bathrooms",
    "housing_context","condominium_name","is_rear_unit","has_stairs_access",
    "room_count","has_living_room","has_kitchen","laundry_type",
    "garage_scope","garage_vehicle","has_electronic_gate",
    "google_maps_url","neighborhood","city","address","description","youtube"
  ];

  lockedNames.forEach(name=>{
    const field=form.querySelector(`[name="${name}"]`);
    if(!field) return;
    field.disabled=true;
    field.classList.add("published-field-locked");
    const label=field.closest("label");
    label?.classList.add("published-field-lock-wrap");
  });

  form.classList.add("editing-published-property");
}

function propertyModal(property=null){
  pendingPropertyFiles=[];
  pendingPropertyCoverExplicit=false;

  if(!property && creditBalance()<=0){
    alert("Seu saldo de créditos está zerado. Compre créditos para publicar um novo imóvel.");
    return;
  }

  const selectedIds=(property?.property_features||[]).map(x=>x.feature_id);
  const furnitureChips=featureChips("furniture",selectedIds);
  const includedChips=featureChips("included",selectedIds);
  const securityChips=featureChips("security",selectedIds);
  const nearbyChips=featureChips("nearby",selectedIds);

  showAdvisorPropertyPage(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">${property?"EDITAR ANÚNCIO":"NOVO ANÚNCIO"}</p>
        <h2>${property?"Editar imóvel":"Cadastrar imóvel"}</h2>
        <p class="muted property-form-lead">${property
          ? "Este anúncio já está vinculado a este imóvel. Campos estruturais, localização, descrição e mídia ficam bloqueados; você pode editar valores, status, contato e marcações."
          : "Preencha as informações do imóvel. Os campos estão organizados por etapas para facilitar pelo celular."}</p>
      </div>
      <button class="icon-btn" data-property-close>✕</button>
    </div>

    <form id="advisorPropertyForm" class="form-grid advisor-property-form">
      <input type="hidden" name="id" value="${property?.id||""}">

      ${property?`
        <div class="span-2 published-property-lock-banner">
          <strong>🔒 1 anúncio = 1 imóvel</strong>
          <span>Depois de publicado, este anúncio não pode ser transformado em outro imóvel. Dados estruturais, descrição, localização e mídias permanecem fixos até o fim desta publicação.</span>
        </div>
      `:""}

      <div class="form-section-title property-section-title">1. Informações principais</div>

      <label class="span-2">Título do anúncio
        <input name="title" required value="${escapeHTML(property?.title||"")}" placeholder="Ex.: Apartamento mobiliado próximo à faculdade">
      </label>

      <label>Tipo de imóvel
        <select name="property_type">
          ${["apartamento","casa","monoambiente","kitnet","outro"].map(t=>`<option value="${t}" ${property?.property_type===t?"selected":""}>${propertyTypeLabel(t)}</option>`).join("")}
        </select>
      </label>

      <label>Status
        <select name="status">
          <option value="available" ${property?.status!=="rented"?"selected":""}>Disponível</option>
          <option value="rented" ${property?.status==="rented"?"selected":""}>Alugado</option>
        </select>
      </label>

      <label>Quartos
        <select name="bedrooms">${countOptions(property?.bedrooms,10)}</select>
      </label>

      <label>Banheiros
        <select name="bathrooms">${countOptions(property?.bathrooms,10)}</select>
      </label>

      <label>O imóvel é mobiliado?
        <select name="furnished">
          <option value="false" ${!property?.furnished?"selected":""}>Não</option>
          <option value="true" ${property?.furnished?"selected":""}>Sim</option>
        </select>
      </label>

      <label>WhatsApp para contato
        <input name="contact_whatsapp" inputmode="tel" required value="${escapeHTML(property?.contact_whatsapp||profile?.whatsapp||"")}" placeholder="Ex.: 595981123456">
      </label>

      <div class="form-section-title property-section-title">2. Valores e condições</div>

      <label>Moeda
        <select name="currency" required>
          <option value="BRL" ${(property?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${property?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>

      <label>Valor mensal
        <input name="price" type="number" min="0" step="1" required value="${property?.price??""}" placeholder="Ex.: 1500">
      </label>

      <label>Valor da caução
        <input name="security_deposit" type="number" min="0" step="1" value="${property?.security_deposit??""}" placeholder="Ex.: 1500">
      </label>

      <label>Caução pode ser parcelada?
        <select name="security_deposit_installment_allowed">
          <option value="false" ${!property?.security_deposit_installment_allowed?"selected":""}>Não</option>
          <option value="true" ${property?.security_deposit_installment_allowed?"selected":""}>Sim</option>
        </select>
      </label>

      <label>Máximo de parcelas
        <select name="security_deposit_max_installments">
          <option value="">Não informar</option>
          ${Array.from({length:11},(_,i)=>i+2).map(n=>`<option value="${n}" ${Number(property?.security_deposit_max_installments)===n?"selected":""}>${n}x</option>`).join("")}
        </select>
      </label>

      <label>Você anuncia este imóvel como
        <select name="advertiser_role" required>
          <option value="broker" ${(property?.advertiser_role||"broker")==="broker"?"selected":""}>Corretor / assessor do imóvel</option>
          <option value="owner" ${property?.advertiser_role==="owner"?"selected":""}>Proprietário do imóvel</option>
        </select>
      </label>

      <label>Existe taxa de assessoria?
        <select name="has_advisory_fee" id="advisorHasAdvisoryFee">
          <option value="false" ${!property?.has_advisory_fee?"selected":""}>Não</option>
          <option value="true" ${property?.has_advisory_fee?"selected":""}>Sim</option>
        </select>
      </label>

      <label id="advisorAdvisoryFeeField" class="${property?.has_advisory_fee?"":"hidden"}">Valor da assessoria
        <input name="advisory_fee" type="number" min="0" step="1" value="${property?.advisory_fee??""}" placeholder="Ex.: 300">
        <small>Esse valor será informado publicamente no anúncio.</small>
      </label>

            <label>Forma de fechamento
        <select name="closing_mode">
          <option value="advisor" ${property?.closing_mode!=="direct_owner"?"selected":""}>Via assessoria</option>
          <option value="direct_owner" ${property?.closing_mode==="direct_owner"?"selected":""}>Direto com o proprietário</option>
        </select>
      </label>

      <div class="form-section-title property-section-title">3. Tipo, acesso e distribuição</div>

      <label>O imóvel é
        <select name="housing_context" id="housingContext">
          <option value="independent" ${property?.housing_context!=="condominium"?"selected":""}>Independente</option>
          <option value="condominium" ${property?.housing_context==="condominium"?"selected":""}>Em condomínio</option>
        </select>
      </label>

      <label id="condominiumNameField" class="${property?.housing_context==="condominium"?"":"hidden"}">Nome do condomínio
        <input name="condominium_name" value="${escapeHTML(property?.condominium_name||"")}" placeholder="Ex.: Residencial Central">
      </label>

      <label>É imóvel de fundo?
        <select name="is_rear_unit">
          <option value="false" ${!property?.is_rear_unit?"selected":""}>Não</option>
          <option value="true" ${property?.is_rear_unit?"selected":""}>Sim</option>
        </select>
      </label>

      <label>Tem escada para acessar o imóvel?
        <select name="has_stairs_access">
          <option value="false" ${!property?.has_stairs_access?"selected":""}>Não</option>
          <option value="true" ${property?.has_stairs_access?"selected":""}>Sim</option>
        </select>
      </label>

      <div id="distributionFields" class="span-2 conditional-subgrid ${property?.property_type==="monoambiente"?"hidden":""}">
        <label>Quantidade total de cômodos
          <input name="room_count" type="number" min="1" step="1" value="${property?.room_count??""}" placeholder="Ex.: 5">
        </label>

        <label>Sala
          <select name="has_living_room">
            <option value="false" ${!property?.has_living_room?"selected":""}>Não</option>
            <option value="true" ${property?.has_living_room?"selected":""}>Sim</option>
          </select>
        </label>

        <label>Cozinha
          <select name="has_kitchen">
            <option value="false" ${!property?.has_kitchen?"selected":""}>Não</option>
            <option value="true" ${property?.has_kitchen?"selected":""}>Sim</option>
          </select>
        </label>
      </div>

      <label>Lavanderia
        <select name="laundry_type">
          <option value="none" ${(property?.laundry_type||"none")==="none"?"selected":""}>Não possui</option>
          <option value="private" ${property?.laundry_type==="private"?"selected":""}>Privativa</option>
          <option value="shared" ${property?.laundry_type==="shared"?"selected":""}>Compartilhada</option>
        </select>
      </label>

      <label>Garagem
        <select name="garage_scope" id="garageScope">
          <option value="none" ${(property?.garage_scope||"none")==="none"?"selected":""}>Não possui</option>
          <option value="shared" ${property?.garage_scope==="shared"?"selected":""}>Coletiva / compartilhada</option>
          <option value="private" ${property?.garage_scope==="private"?"selected":""}>Própria / privativa</option>
        </select>
      </label>

      <div id="garageDetails" class="span-2 conditional-subgrid ${property?.garage_scope && property.garage_scope!=="none"?"":"hidden"}">
        <label>Garagem para
          <select name="garage_vehicle">
            <option value="car_motorcycle" ${property?.garage_vehicle==="car_motorcycle"?"selected":""}>Carro e moto</option>
            <option value="car" ${property?.garage_vehicle==="car"?"selected":""}>Somente carro</option>
            <option value="motorcycle" ${property?.garage_vehicle==="motorcycle"?"selected":""}>Somente moto</option>
          </select>
        </label>

        <label>Portão eletrônico?
          <select name="has_electronic_gate">
            <option value="false" ${!property?.has_electronic_gate?"selected":""}>Não</option>
            <option value="true" ${property?.has_electronic_gate?"selected":""}>Sim</option>
          </select>
        </label>
      </div>

      <div class="form-section-title property-section-title">4. Mobília e estrutura</div>
      <div class="span-2 property-options-help">Marque tudo que existe no imóvel.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${furnitureChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">5. Segurança</div>
      <div class="span-2 property-options-help">Marque os recursos de segurança disponíveis.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${securityChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">6. Comodidades próximas</div>
      <div class="span-2 property-options-help">Marque o que existe nas proximidades do imóvel.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${nearbyChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">7. O que está incluso no aluguel</div>
      <div class="span-2 property-options-help">Marque somente o que já está incluído no valor mensal.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${includedChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">8. Localização privada</div>

      <div class="span-2 property-location-privacy">
        <strong>🔒 A localização exata não será exibida ao público.</strong>
        <span>Ela é usada internamente para calcular a distância até as faculdades e auxiliar você na organização da visita. O cliente verá apenas bairro/cidade e as distâncias calculadas.</span>
      </div>

      <label class="span-2 maps-link-field">Link exato do imóvel no Google Maps
        <input name="google_maps_url" type="url" required value="${escapeHTML(property?.google_maps_url||"")}" placeholder="Google Maps → local exato → Compartilhar → Copiar link">
        <small>Obrigatório. Selecione o ponto exato do imóvel. Esse link fica privado e não é enviado ao visitante.</small>
      </label>

      <label>Bairro exibido no catálogo
        <input name="neighborhood" value="${escapeHTML(property?.neighborhood||"")}" placeholder="Ex.: Centro">
      </label>

      <label>Cidade exibida no catálogo
        <select name="city" required>
          <option value="">Selecione a cidade</option>
          <option value="Pedro Juan Caballero" ${(property?.city||profile?.city)==="Pedro Juan Caballero"?"selected":""}>Pedro Juan Caballero</option>
          <option value="Ponta Porã" ${(property?.city||profile?.city)==="Ponta Porã"?"selected":""}>Ponta Porã</option>
        </select>
      </label>

      <label class="span-2">Endereço exato escrito (privado e opcional)
        <input name="address" value="${escapeHTML(property?.address||"")}" placeholder="Rua, número, referência interna">
        <small>Este endereço também fica restrito ao assessor/administrador.</small>
      </label>

      <div class="form-section-title property-section-title">9. Fotos, vídeo e descrição</div>

      <label class="span-2">Descrição do imóvel
        <textarea name="description" placeholder="Descreva o imóvel, condições e diferenciais.">${escapeHTML(property?.description||"")}</textarea>
      </label>

      ${property?existingPropertyMediaHtml(property):""}

      ${property?`
        <div class="span-2 published-media-lock-note">
          🔒 As fotos e o vídeo pertencem ao imóvel original e não podem ser adicionados, removidos ou substituídos nesta publicação. Você ainda pode escolher a capa e reorganizar as fotos já existentes.
        </div>
        <input type="hidden" name="youtube" value="${escapeHTML(propertyYoutubeMedia(property)?.external_url||"")}">
      `:`
        <div class="span-2 property-photo-single-wrap">
          <strong>Adicionar fotos</strong>
          <span class="property-options-help">Adicione uma foto por vez. Cada nova foto entra automaticamente na sequência Foto 1, Foto 2, Foto 3...</span>

          <div class="upload single-property-upload">
            <input id="advisorSinglePhotoInput" type="file" accept="image/jpeg,image/png,image/webp">
            <div class="single-property-upload-copy">
              <strong>📷 Escolher foto da galeria</strong>
              <small>JPG, PNG ou WEBP · uma foto por vez</small>
            </div>
          </div>

          <small>A primeira foto será a principal. Depois você pode reorganizar e trocar a capa.</small>
        </div>

        <div id="pendingPropertyPhotos" class="span-2 property-media-editor-grid"></div>

        <label class="span-2">Vídeo do imóvel (YouTube)
          <input name="youtube" type="url" value="" placeholder="https://youtube.com/watch?v=...">
          <small>Opcional. Cole o link do vídeo do imóvel publicado no YouTube.</small>
        </label>
      `}

      ${property?`<div class="span-2 edit-expiry-lock">🔒 A validade permanece em <strong>${fmtDate(property.listing_expires_at)}</strong>. Editar não reinicia os 30 dias.</div>`:""}
      <div id="propertyDraftStatus" class="span-2 property-draft-status hidden"></div>

      <div class="span-2 property-draft-actions">
        <button type="button" class="btn ghost" data-save-property-draft>💾 Salvar rascunho</button>
        <button type="button" class="btn ghost draft-delete-btn" data-delete-property-draft>🗑️ Excluir rascunho</button>
      </div>

      <div class="form-actions">
        <button type="button" class="btn ghost" data-property-close>Cancelar</button>
        <button class="btn primary" type="button" data-publish-property>${property?"Salvar alterações":"Publicar imóvel"}</button>
      </div>
      ${!property?`<div class="span-2 publish-lock-preview"><strong>⚠️ Antes de publicar:</strong> você verá uma confirmação mostrando o que poderá e o que não poderá mais ser alterado neste anúncio.</div>`:""}
      <div id="advisorPropertyMessage" class="span-2 form-message"></div>
    </form>`);

  const imageInput=$("#advisorSinglePhotoInput");
  imageInput?.addEventListener("change",()=>{
    const file=imageInput.files?.[0]||null;
    if(!file) return;

    if(!["image/jpeg","image/png","image/webp"].includes(file.type)){
      alert("Use uma imagem JPG, PNG ou WEBP.");
      imageInput.value="";
      return;
    }

    pendingPropertyFiles.push(file);
    if(pendingPropertyFiles.length===1 && !(property?.property_media||[]).some(m=>m.media_type==="image")){
      pendingPropertyCoverExplicit=true;
    }

    renderPendingPropertyPhotos();

    // Limpa o input para permitir escolher outra foto usando o mesmo botão.
    imageInput.value="";
  });
  renderPendingPropertyPhotos();
  wirePropertyTechnicalFields($("#advisorPropertyForm"));
  applyPublishedPropertyEditLock($("#advisorPropertyForm"),property);
  if(!property) loadPropertyDraft($("#advisorPropertyForm"),property);
}

async function saveProperty(form){
  const fd=new FormData(form);
  const id=fd.get("id")||null;
  const existing=id?properties.find(p=>p.id===id):null;
  const msg=$("#advisorPropertyMessage");

  if(!existing && creditBalance()<=0){
    msg.textContent="Seu saldo de créditos está zerado. Compre créditos para publicar um novo imóvel.";
    return false;
  }

  const title=existing?.title || String(fd.get("title")||"").trim();
  if(!title){
    msg.textContent="Informe o título do anúncio.";
    return false;
  }

  const existingImageCount=(existing?.property_media||[]).filter(m=>m.media_type==="image").length;
  if(!existingImageCount && !pendingPropertyFiles.length){
    msg.textContent="Você precisa adicionar pelo menos uma foto do imóvel.";
    return false;
  }

  const youtubeUrl=existing
    ? String(propertyYoutubeMedia(existing)?.external_url||"").trim()
    : String(fd.get("youtube")||"").trim();
  if(youtubeUrl && !/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/.test(youtubeUrl)){
    msg.textContent="Cole um link válido do YouTube ou deixe o campo de vídeo vazio.";
    return false;
  }

  const googleMapsUrl=existing?.google_maps_url || String(fd.get("google_maps_url")||"").trim()||null;
  let latitude=existing?.latitude??null;
  let longitude=existing?.longitude??null;

  if(googleMapsUrl && !existing){
    msg.textContent="1/4 • Validando localização...";
    const resolved=await withTimeout(
      db.functions.invoke("resolve-maps-link",{body:{url:googleMapsUrl}}),
      12000,
      "Leitura do Google Maps"
    );
    if(resolved.error || resolved.data?.error){
      msg.textContent=resolved.data?.error || resolved.error?.message || "Não foi possível ler o link do Google Maps.";
      return false;
    }
    if(resolved.data?.latitude!=null && resolved.data?.longitude!=null){
      latitude=Number(resolved.data.latitude);
      longitude=Number(resolved.data.longitude);
    }
  }

  const row={
    title,
    slug:existing?.slug || title.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")+"-"+Date.now().toString(36),
    property_type:fd.get("property_type"),
    description:String(fd.get("description")||"").trim()||null,
    price:Number(fd.get("price")),
    currency:fd.get("currency")||"BRL",
    security_deposit:fd.get("security_deposit")?Number(fd.get("security_deposit")):null,
    security_deposit_installment_allowed:fd.get("security_deposit_installment_allowed")==="true",
    security_deposit_max_installments:fd.get("security_deposit_installment_allowed")==="true" && fd.get("security_deposit_max_installments")?Number(fd.get("security_deposit_max_installments")):null,
    closing_mode:fd.get("closing_mode"),
    advertiser_role:fd.get("advertiser_role")||"broker",
    has_advisory_fee:fd.get("has_advisory_fee")==="true",
    advisory_fee:fd.get("has_advisory_fee")==="true" && fd.get("advisory_fee")!=="" ? Number(fd.get("advisory_fee")) : null,
    contact_whatsapp:String(fd.get("contact_whatsapp")||"").replace(/\D/g,""),
    bedrooms:Number(fd.get("bedrooms")||0),
    bathrooms:Number(fd.get("bathrooms")||0),
    furnished:fd.get("furnished")==="true",
    housing_context:fd.get("housing_context")||"independent",
    condominium_name:fd.get("housing_context")==="condominium" ? String(fd.get("condominium_name")||"").trim()||null : null,
    is_rear_unit:fd.get("is_rear_unit")==="true",
    has_stairs_access:fd.get("has_stairs_access")==="true",
    room_count:fd.get("property_type")==="monoambiente" ? null : (fd.get("room_count")?Number(fd.get("room_count")):null),
    has_living_room:fd.get("property_type")==="monoambiente" ? false : fd.get("has_living_room")==="true",
    has_kitchen:fd.get("property_type")==="monoambiente" ? false : fd.get("has_kitchen")==="true",
    laundry_type:fd.get("laundry_type")||"none",
    garage_scope:fd.get("garage_scope")||"none",
    garage_vehicle:fd.get("garage_scope")==="none" ? "none" : (fd.get("garage_vehicle")||"none"),
    has_electronic_gate:fd.get("garage_scope")==="none" ? false : fd.get("has_electronic_gate")==="true",
    neighborhood:String(fd.get("neighborhood")||"").trim()||null,
    city:String(fd.get("city")||"").trim()||null,
    address:String(fd.get("address")||"").trim()||null,
    google_maps_url:googleMapsUrl,
    latitude,
    longitude,
    show_exact_location:false,
    status:fd.get("status")
  };

  const selectedFeatureIds=[...form.querySelectorAll('input[name="features"]:checked')].map(el=>el.value);

  // EDITAR: mantém identidade e prazo do anúncio original.
  if(existing){
    msg.textContent="2/4 • Salvando alterações...";

    const updateRow={
      price:row.price,
      currency:row.currency,
      security_deposit:row.security_deposit,
      security_deposit_installment_allowed:row.security_deposit_installment_allowed,
      security_deposit_max_installments:row.security_deposit_max_installments,
      closing_mode:row.closing_mode,
      advertiser_role:row.advertiser_role,
      has_advisory_fee:row.has_advisory_fee,
      advisory_fee:row.advisory_fee,
      contact_whatsapp:row.contact_whatsapp,
      furnished:row.furnished,
      status:row.status
    };

    const upd=await db.from("properties")
      .update(updateRow)
      .eq("id",existing.id)
      .eq("advisor_id",currentUser.id);

    if(upd.error){
      msg.textContent="Não foi possível salvar: "+upd.error.message;
      return false;
    }

    const delFeatures=await db.from("property_features").delete().eq("property_id",existing.id);
    if(delFeatures.error){
      msg.textContent="Não foi possível atualizar as características: "+delFeatures.error.message;
      return false;
    }

    if(selectedFeatureIds.length){
      const featureRows=selectedFeatureIds.map(feature_id=>({property_id:existing.id,feature_id}));
      const featureInsert=await db.from("property_features").insert(featureRows);
      if(featureInsert.error){
        msg.textContent="Não foi possível atualizar as características: "+featureInsert.error.message;
        return false;
      }
    }

    msg.textContent="3/4 • Mantendo mídia e identidade original do imóvel...";

    await deletePropertyDraft(form,{silent:true});
    msg.textContent="4/4 • Alterações salvas com sucesso.";
    await loadData();
    renderPanel();
    closeAdvisorPropertyPage();
    return true;
  }

  // NOVA PUBLICAÇÃO: primeiro envia as fotos para um ID reservado.
  // O imóvel só é criado e publicado depois que todas as fotos estiverem prontas.
  const propertyId=crypto.randomUUID();
  const uploadedPaths=[];
  const media=[];

  try{
    msg.textContent="2/4 • Enviando fotos...";
    for(let index=0;index<pendingPropertyFiles.length;index++){
      const file=pendingPropertyFiles[index];
      const safe=file.name.replace(/[^A-Za-z0-9._-]/g,"_");
      const path=`${currentUser.id}/${propertyId}/${crypto.randomUUID()}-${safe}`;

      const up=await db.storage.from(STORAGE_BUCKET).upload(path,file,{
        contentType:file.type||undefined,
        cacheControl:"3600",
        upsert:false
      });
      if(up.error) throw new Error("Falha ao enviar a foto "+(index+1)+": "+up.error.message);

      uploadedPaths.push(path);
      media.push({
        media_type:"image",
        storage_path:path,
        is_cover:index===0,
        sort_order:index*10
      });
    }

    if(youtubeUrl){
      media.push({
        media_type:"youtube",
        external_url:youtubeUrl,
        is_cover:false,
        sort_order:10000
      });
    }

    msg.textContent="3/4 • Registrando e publicando imóvel...";
    const published=await withTimeout(
      db.rpc("publish_advisor_property",{
        p_property_id:propertyId,
        p_subscription_id:null,
        p_property:row,
        p_feature_ids:selectedFeatureIds,
        p_media:media
      }),
      15000,
      "Publicação do imóvel"
    );

    if(published.error) throw new Error(published.error.message);

    msg.textContent="4/4 • Imóvel publicado com sucesso.";
    await deletePropertyDraft(form,{silent:true});
    await loadData();
    renderPanel();

    const created=properties.find(p=>p.id===propertyId);
    if(!created){
      throw new Error("O imóvel foi publicado, mas o painel ainda não conseguiu recarregá-lo.");
    }

    closeAdvisorPropertyPage();
    return true;
  }catch(err){
    console.error("Falha na publicação atômica do imóvel:",err);

    if(uploadedPaths.length){
      try{ await db.storage.from(STORAGE_BUCKET).remove(uploadedPaths); }catch{}
    }

    msg.textContent="Não foi possível publicar: "+(err?.message||"erro desconhecido");
    return false;
  }
}

async function setAdvisorCover(mediaId,propertyId){
  const property=properties.find(p=>p.id===propertyId);
  if(!property) return;

  const images=(property.property_media||[])
    .filter(m=>m.media_type==="image")
    .sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));

  const chosen=images.find(m=>m.id===mediaId);
  if(!chosen) return;

  const {error:clearError}=await db.from("property_media")
    .update({is_cover:false})
    .eq("property_id",propertyId)
    .eq("media_type","image");
  if(clearError) return alert(clearError.message);

  const {error:setError}=await db.from("property_media")
    .update({is_cover:true,sort_order:0})
    .eq("id",mediaId);
  if(setError) return alert(setError.message);

  let order=10;
  for(const image of images.filter(m=>m.id!==mediaId)){
    await db.from("property_media").update({sort_order:order}).eq("id",image.id);
    order+=10;
  }

  await loadData();
  propertyModal(properties.find(p=>p.id===propertyId));
}

async function moveAdvisorMedia(mediaId,propertyId,direction){
  const property=properties.find(p=>p.id===propertyId);
  if(!property) return;

  const images=(property.property_media||[])
    .filter(m=>m.media_type==="image")
    .sort((a,b)=>Number(b.is_cover)-Number(a.is_cover) || Number(a.sort_order||0)-Number(b.sort_order||0));

  const index=images.findIndex(m=>m.id===mediaId);
  const target=index+Number(direction);
  if(index<0 || target<0 || target>=images.length) return;

  const reordered=[...images];
  [reordered[index],reordered[target]]=[reordered[target],reordered[index]];

  // A capa continua sendo capa; as setas alteram apenas a sequência das demais fotos.
  const cover=reordered.find(m=>m.is_cover);
  const rest=reordered.filter(m=>!m.is_cover);
  let order=cover?10:0;
  for(const image of rest){
    await db.from("property_media").update({sort_order:order}).eq("id",image.id);
    order+=10;
  }
  if(cover) await db.from("property_media").update({sort_order:0}).eq("id",cover.id);

  await loadData();
  propertyModal(properties.find(p=>p.id===propertyId));
}

async function deleteAdvisorMedia(mediaId,propertyId){
  const property=properties.find(p=>p.id===propertyId);
  const media=(property?.property_media||[]).find(m=>m.id===mediaId);
  if(!media || !confirm("Excluir esta mídia do anúncio?")) return;

  if(media.media_type==="image" && media.storage_path){
    await db.storage.from(STORAGE_BUCKET).remove([media.storage_path]);
  }
  const {error}=await db.from("property_media").delete().eq("id",mediaId);
  if(error) return alert(error.message);

  await loadData();
  const refreshed=properties.find(p=>p.id===propertyId);
  const images=(refreshed?.property_media||[]).filter(m=>m.media_type==="image");
  if(media.is_cover && images.length){
    const next=[...images].sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0))[0];
    await db.from("property_media").update({is_cover:true,sort_order:0}).eq("id",next.id);
    await loadData();
  }
  propertyModal(properties.find(p=>p.id===propertyId));
}

async function watchPaymentStatus(subscriptionId){
  if(paymentWatcher) clearInterval(paymentWatcher);

  let attempts=0;
  const maxAttempts=90; // ~3 minutos

  const check=async()=>{
    attempts++;

    try{
      const {data,error}=await db.functions.invoke("check-advisor-pix",{
        body:{subscription_id:subscriptionId}
      });

      if(error || data?.error) throw new Error(data?.error || error?.message || "Falha ao verificar pagamento.");

      const statusEl=$("#pixStatus");
      if(data?.status==="active"){
        if(paymentWatcher){
          clearInterval(paymentWatcher);
          paymentWatcher=null;
        }

        if(statusEl){
          statusEl.innerHTML='<strong>Pagamento aprovado ✓</strong><span>Seus créditos foram adicionados ao saldo. Atualizando sua carteira...</span>';
          statusEl.classList.add("pix-approved");
        }

        await loadData();
        renderPanel();

        setTimeout(()=>{
          closeAdvisorModal();
        },1200);

        return;
      }

      if(data?.status==="cancelled" || data?.status==="expired"){
        if(paymentWatcher){
          clearInterval(paymentWatcher);
          paymentWatcher=null;
        }
        if(statusEl){
          statusEl.innerHTML='<strong>Pagamento não concluído.</strong><span>Feche esta janela e gere um novo PIX.</span>';
        }
        return;
      }

      if(attempts>=maxAttempts){
        clearInterval(paymentWatcher);
        paymentWatcher=null;
        if(statusEl){
          statusEl.innerHTML='<strong>Ainda aguardando confirmação.</strong><span>Se você já pagou, pode fechar esta janela. Os créditos serão liberados automaticamente assim que o Mercado Pago confirmar.</span>';
        }
      }
    }catch(err){
      console.warn("Falha temporária ao consultar pagamento:",err);
    }
  };

  await check();
  if(!paymentWatcher){
    paymentWatcher=setInterval(check,2000);
  }
}

async function startPayment(planId){
  const {data,error}=await db.functions.invoke("create-advisor-pix",{body:{plan_id:planId}});
  if(error || !data || data.error){
    alert(data?.error || error?.message || "A integração PIX ainda está sendo finalizada.");
    return;
  }
  showAdvisorModal(`
    <div class="modal-head"><div><p class="eyebrow">PAGAMENTO PIX</p><h2>Concluir pagamento</h2></div><button class="icon-btn" data-close>✕</button></div>
    <div class="pix-box">
      <strong>Total: ${money(data.amount,"BRL")}</strong>
      <span class="promo-label">Após a confirmação, os créditos entram automaticamente no seu saldo.</span>
      ${data.qr_code_base64?`<img class="pix-qr" src="data:image/png;base64,${data.qr_code_base64}" alt="QR Code PIX">`:""}
      ${data.qr_code?`<textarea id="pixCopy" readonly>${escapeHTML(data.qr_code)}</textarea><button class="btn primary" id="copyPix">Copiar PIX</button>`:""}
      <div id="pixStatus" class="pix-payment-status"><strong>Aguardando confirmação do pagamento...</strong><span>Assim que o Mercado Pago confirmar, esta tela será atualizada automaticamente.</span></div>
    </div>`);
  $("#copyPix")?.addEventListener("click",async()=>{await navigator.clipboard.writeText($("#pixCopy").value);$("#copyPix").textContent="PIX copiado ✓";});
  if(data.subscription_id) watchPaymentStatus(data.subscription_id);
}

async function enterAdvisorPanel(user){
  if(!user) throw new Error("Usuário não identificado após o login.");

  const {data:adminRow,error:adminCheckError}=await db
    .from("admin_users")
    .select("user_id")
    .eq("user_id",user.id)
    .maybeSingle();

  if(adminCheckError){
    console.warn("Não foi possível verificar o tipo da conta:",adminCheckError);
  }

  if(adminRow){
    await db.auth.signOut();
    currentUser=null;
    profile=null;
    $("#advisorBootLoader")?.classList.add("hidden");
    $("#advisorPanel")?.classList.add("hidden");
    $("#advisorPropertyPage")?.classList.add("hidden");
    $("#advisorResetPassword")?.classList.add("hidden");
    $("#advisorAuth")?.classList.remove("hidden");
    $("#advisorAuthMessage").textContent="Esta conta é exclusiva do painel administrativo. Entre com uma conta de assessor.";
    throw new Error("Conta administrativa não pode acessar a Área do Assessor.");
  }

  currentUser=user;

  // Mostra o painel imediatamente após a autenticação, sem exibir o login no meio.
  $("#advisorBootLoader")?.classList.add("hidden");
  $("#advisorAuth").classList.add("hidden");
  $("#advisorResetPassword").classList.add("hidden");
  $("#advisorPropertyPage")?.classList.add("hidden");
  $("#advisorPanel").classList.remove("hidden");
  $("#advisorWelcome").textContent="Carregando sua área...";

  try{
    await ensureProfile(user);
    const fullyLoaded=await loadData();
    renderPanel();
    if(!fullyLoaded){
      $("#advisorExpiredNotice").innerHTML=
        '<div class="advisor-expired-alert"><strong>Painel aberto.</strong><span>Algumas informações demoraram para carregar. Atualize a página se algum plano ou anúncio não aparecer.</span></div>';
    }
  }catch(err){
    console.error("Erro ao carregar a Área do Assessor:",err);
    $("#advisorWelcome").textContent="Área do Assessor";
    $("#advisorExpiredNotice").innerHTML=
      '<div class="advisor-expired-alert"><strong>Login realizado.</strong><span>Houve um erro ao carregar os dados do painel. Atualize a página para tentar novamente.</span></div>';
  }
}

async function boot(){
  const hashParams=new URLSearchParams(location.hash.replace(/^#/,""));
  const searchParams=new URLSearchParams(location.search);
  const isRecovery=hashParams.get("type")==="recovery" || searchParams.get("type")==="recovery";

  if(isRecovery){
    $("#advisorBootLoader")?.classList.add("hidden");
    $("#advisorAuth").classList.add("hidden");
    $("#advisorPanel").classList.add("hidden");
    $("#advisorPropertyPage")?.classList.add("hidden");
    $("#advisorResetPassword").classList.remove("hidden");
    return;
  }

  const loader=$("#advisorBootLoader");
  const bootTitle=$("#advisorBootTitle");
  const bootText=$("#advisorBootText");
  const bootActions=$("#advisorBootActions");
  const bootSpinner=$("#advisorBootSpinner");

  if(loader) loader.classList.remove("hidden");
  if(bootActions) bootActions.classList.add("hidden");
  if(bootSpinner) bootSpinner.classList.remove("hidden");
  if(bootTitle) bootTitle.textContent="Abrindo sua área...";
  if(bootText) bootText.textContent="Validando sua sessão.";

  try{
    // getUser valida o usuário atual no servidor e evita depender apenas
    // de uma sessão local antiga do navegador.
    const userResult=await withTimeout(
      db.auth.getUser(),
      7000,
      "Validação da sessão"
    );

    const user=userResult?.data?.user||null;
    const authError=userResult?.error||null;

    if(authError || !user){
      currentUser=null;
      loader?.classList.add("hidden");
      $("#advisorAuth").classList.remove("hidden");
      $("#advisorPanel").classList.add("hidden");

      if(authError){
        $("#advisorAuthMessage").textContent="Sua sessão neste navegador expirou. Entre novamente.";
      }
      return;
    }

    currentUser=user;
    await enterAdvisorPanel(user);
  }catch(err){
    console.warn("Falha ao validar sessão neste dispositivo:",err);

    if(bootSpinner) bootSpinner.classList.add("hidden");
    if(bootTitle) bootTitle.textContent="Não conseguimos validar sua sessão neste navegador.";
    if(bootText) bootText.textContent="Tente novamente. Se continuar, entre novamente para criar uma sessão nova neste navegador.";
    if(bootActions) bootActions.classList.remove("hidden");
  }
}

document.addEventListener("click",async e=>{
  const tab=e.target.closest("[data-auth-tab]");
  if(tab){
    document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b===tab));
    $("#advisorLoginForm").classList.toggle("hidden",tab.dataset.authTab!=="login");
    $("#advisorSignupForm").classList.toggle("hidden",tab.dataset.authTab!=="signup");
  }
  const propertyClose=e.target.closest("[data-property-close]");
  if(propertyClose){
    closeAdvisorPropertyPage();
    return;
  }

    const publishPropertyBtn=e.target.closest("[data-publish-property]");
  if(publishPropertyBtn){
    e.preventDefault();
    await runPropertySave($("#advisorPropertyForm"));
    return;
  }

    const saveDraftBtn=e.target.closest("[data-save-property-draft]");
  if(saveDraftBtn){
    const form=$("#advisorPropertyForm");
    if(form) await savePropertyDraft(form);
  }

  const deleteDraftBtn=e.target.closest("[data-delete-property-draft]");
  if(deleteDraftBtn){
    const form=$("#advisorPropertyForm");
    if(form && confirm("Excluir o rascunho salvo deste imóvel?")){
      await deletePropertyDraft(form);
    }
  }

  const pendingLeft=e.target.closest("[data-pending-left]");
  if(pendingLeft){
    const i=Number(pendingLeft.dataset.pendingLeft);
    if(i>0){
      [pendingPropertyFiles[i-1],pendingPropertyFiles[i]]=[pendingPropertyFiles[i],pendingPropertyFiles[i-1]];
      renderPendingPropertyPhotos();
    }
  }
  const pendingRight=e.target.closest("[data-pending-right]");
  if(pendingRight){
    const i=Number(pendingRight.dataset.pendingRight);
    if(i<pendingPropertyFiles.length-1){
      [pendingPropertyFiles[i+1],pendingPropertyFiles[i]]=[pendingPropertyFiles[i],pendingPropertyFiles[i+1]];
      renderPendingPropertyPhotos();
    }
  }
  const pendingCover=e.target.closest("[data-pending-cover]");
  if(pendingCover){
    const i=Number(pendingCover.dataset.pendingCover);
    if(i>=0 && i<pendingPropertyFiles.length){
      const selected=pendingPropertyFiles.splice(i,1)[0];
      pendingPropertyFiles.unshift(selected);
      pendingPropertyCoverExplicit=true;
      renderPendingPropertyPhotos();
    }
  }
  const pendingRemove=e.target.closest("[data-pending-remove]");
  if(pendingRemove){
    const i=Number(pendingRemove.dataset.pendingRemove);
    pendingPropertyFiles.splice(i,1);
    renderPendingPropertyPhotos();
  }

  const mediaCover=e.target.closest("[data-media-cover]");
  if(mediaCover){
    const propertyId=mediaCover.dataset.property;
    const item=properties.find(p=>p.id===propertyId);
    const images=sortedPropertyImages(item);
    const chosen=images.find(m=>m.id===mediaCover.dataset.mediaCover);
    if(chosen){
      const ordered=[chosen,...images.filter(m=>m.id!==chosen.id)];
      await db.from("property_media").update({is_cover:false}).eq("property_id",propertyId).eq("media_type","image");
      for(let i=0;i<ordered.length;i++){
        await db.from("property_media").update({sort_order:i*10,is_cover:i===0}).eq("id",ordered[i].id);
      }
      await loadData();
      propertyModal(properties.find(p=>p.id===propertyId));
    }
  }

  const mediaDelete=e.target.closest("[data-media-delete]");
  if(mediaDelete && confirm("Excluir esta foto?")){
    const propertyId=mediaDelete.dataset.property;
    const item=properties.find(p=>p.id===propertyId);
    const media=(item?.property_media||[]).find(m=>m.id===mediaDelete.dataset.mediaDelete);
    if(media?.storage_path) await db.storage.from(STORAGE_BUCKET).remove([media.storage_path]);
    await db.from("property_media").delete().eq("id",mediaDelete.dataset.mediaDelete);
    const {data:remaining}=await db.from("property_media").select("id,is_cover,sort_order").eq("property_id",propertyId).eq("media_type","image").order("sort_order");
    if(remaining?.length){
      for(let i=0;i<remaining.length;i++) await db.from("property_media").update({sort_order:i*10,is_cover:i===0}).eq("id",remaining[i].id);
    }
    await loadData();
    propertyModal(properties.find(p=>p.id===propertyId));
  }

  const mediaLeft=e.target.closest("[data-media-left]");
  const mediaRight=e.target.closest("[data-media-right]");
  if(mediaLeft || mediaRight){
    const button=mediaLeft||mediaRight;
    const propertyId=button.dataset.property;
    const item=properties.find(p=>p.id===propertyId);
    const images=sortedPropertyImages(item);
    const id=mediaLeft?button.dataset.mediaLeft:button.dataset.mediaRight;
    const index=images.findIndex(m=>m.id===id);
    const target=mediaLeft?index-1:index+1;
    if(index>=0 && target>=0 && target<images.length){
      [images[index],images[target]]=[images[target],images[index]];
      for(let i=0;i<images.length;i++) await db.from("property_media").update({sort_order:i*10,is_cover:i===0}).eq("id",images[i].id);
      await loadData();
      propertyModal(properties.find(p=>p.id===propertyId));
    }
  }

  const videoDelete=e.target.closest("[data-video-delete]");
  if(videoDelete && confirm("Excluir o vídeo deste imóvel?")){
    const propertyId=videoDelete.dataset.property;
    await db.from("property_media").delete().eq("id",videoDelete.dataset.videoDelete);
    await loadData();
    propertyModal(properties.find(p=>p.id===propertyId));
  }
  const buy=e.target.closest("[data-buy]");
  if(buy) await startPayment(buy.dataset.buy);
  const viewBtn=e.target.closest("[data-advisor-view]");
  if(viewBtn){
    const view=viewBtn.dataset.advisorView;
    document.querySelectorAll("[data-advisor-view]").forEach(btn=>btn.classList.toggle("active",btn===viewBtn));
    $("#advisorDashboardView")?.classList.toggle("hidden",view!=="dashboard");
    $("#advisorRentalControl")?.classList.toggle("hidden",view!=="rentals");
    $("#advisorHowItWorks")?.classList.toggle("hidden",view!=="how");
    window.scrollTo({top:0,behavior:"smooth"});
  }

  const newRental=e.target.closest("[data-new-rental-control]");
  if(newRental) rentalControlModal();

  const editRental=e.target.closest("[data-edit-rental-control]");
  if(editRental){
    const row=rentalControls.find(r=>r.id===editRental.dataset.editRentalControl);
    if(row) rentalControlModal(row);
  }

  const deleteRental=e.target.closest("[data-delete-rental-control]");
  if(deleteRental && confirm("Excluir este registro da sua planilha de controle?")){
    const {error}=await db.from("advisor_rental_control")
      .delete()
      .eq("id",deleteRental.dataset.deleteRentalControl)
      .eq("advisor_id",currentUser.id);
    if(error) alert(error.message);
    else{
      rentalControls=rentalControls.filter(r=>r.id!==deleteRental.dataset.deleteRentalControl);
      renderRentalControl();
    }
  }

    if(e.target.closest("#advisorProfileBtn")) advisorProfileModal();
  if(e.target.closest("#newAdvisorProperty")){
    if(!canCreateAdvisorProperty()){
      alert("Seu saldo de créditos está zerado. Compre créditos para publicar um imóvel.");
    }else{
      propertyModal();
    }
  }

  const coverBtn=e.target.closest("[data-advisor-cover]");
  if(coverBtn) await setAdvisorCover(coverBtn.dataset.advisorCover,coverBtn.dataset.property);

  const moveBtn=e.target.closest("[data-media-move]");
  if(moveBtn) await moveAdvisorMedia(moveBtn.dataset.mediaId,moveBtn.dataset.property,moveBtn.dataset.mediaMove);

  const deleteMediaBtn=e.target.closest("[data-advisor-delete-media]");
  if(deleteMediaBtn) await deleteAdvisorMedia(deleteMediaBtn.dataset.advisorDeleteMedia,deleteMediaBtn.dataset.property);
  const reactivate=e.target.closest("[data-reactivate-ad]");
  if(reactivate){
    if(creditBalance()<=0){
      alert("Seu saldo de créditos está zerado.");
    }else if(confirm("Usar 1 crédito para reativar este imóvel por 30 dias?")){
      reactivate.disabled=true;
      reactivate.textContent="Reativando...";
      const {error}=await db.rpc("reactivate_advisor_property",{p_property_id:reactivate.dataset.reactivateAd});
      if(error){
        alert(error.message);
        reactivate.disabled=false;
        reactivate.textContent="Reativar • 1 crédito";
      }else{
        await loadData();
        renderPanel();
      }
    }
  }

    const edit=e.target.closest("[data-edit-ad]");
  if(edit){
    const item=properties.find(p=>p.id===edit.dataset.editAd);
    if(item?.listing_expires_at && new Date(item.listing_expires_at)<=new Date()){
      alert("Este anúncio expirou. Reative usando 1 crédito para iniciar um novo período de 30 dias.");
    }else{
      propertyModal(item);
    }
  }
  if(e.target.closest("[data-close]")) closeAdvisorModal();
  const del=e.target.closest("[data-delete-ad]");
  if(del && confirm("Excluir este anúncio definitivamente?")){
    const p=properties.find(x=>x.id===del.dataset.deleteAd);
    const paths=(p?.property_media||[]).filter(m=>m.storage_path).map(m=>m.storage_path);
    if(paths.length) await db.storage.from(STORAGE_BUCKET).remove(paths);
    await db.from("properties").delete().eq("id",del.dataset.deleteAd);
    await loadData();renderPanel();
  }
});

$("#advisorModal").addEventListener("submit",async e=>{
  e.preventDefault();
  if(e.target.id==="advisorProfileForm") await saveAdvisorProfile(e.target);
  if(e.target.id==="advisorRentalControlForm") await saveRentalControl(e.target);
});

function confirmFirstPropertyPublication(){
  return new Promise(resolve=>{
    showAdvisorModal(`
      <div class="publication-confirm-modal">
        <div class="modal-head">
          <div>
            <p class="eyebrow">ANTES DE PUBLICAR</p>
            <h2>Confirmar publicação?</h2>
            <p class="muted">Depois que o imóvel entrar no catálogo, este crédito ficará vinculado a este imóvel por 30 dias. O anúncio não poderá ser transformado em outro imóvel.</p>
          </div>
          <button id="publicationReviewClose" class="icon-btn" type="button" aria-label="Voltar e revisar">✕</button>
        </div>

        <div class="publication-confirm-grid">
          <section class="publication-rule-card allowed">
            <h3>✓ Você ainda poderá editar</h3>
            <ul>
              <li>Preço e moeda</li>
              <li>Caução e condições de parcelamento</li>
              <li>Status: disponível ou alugado</li>
              <li>WhatsApp de contato</li>
              <li>Taxa de assessoria e valor</li>
              <li>Se anuncia como corretor/assessor ou proprietário</li>
              <li>Marcação de mobiliado</li>
              <li>Marcações e checklists do imóvel</li>
              <li>Qual foto existente é a capa e a ordem das fotos</li>
            </ul>
          </section>

          <section class="publication-rule-card locked">
            <h3>🔒 Não poderá mais alterar</h3>
            <ul>
              <li>Título e descrição</li>
              <li>Tipo do imóvel</li>
              <li>Quantidade de quartos e banheiros</li>
              <li>Distribuição, cômodos e estrutura</li>
              <li>Condomínio, garagem, lavanderia e acesso</li>
              <li>Bairro, cidade, endereço e localização do Google Maps</li>
              <li>Adicionar, excluir ou substituir fotos</li>
              <li>Adicionar, excluir ou substituir vídeo</li>
            </ul>
          </section>
        </div>

        <div class="publication-confirm-warning">
          <strong>1 crédito = 1 imóvel.</strong>
          <span>Confira os dados, fotos e localização antes de confirmar.</span>
        </div>

        <div class="publication-confirm-actions">
          <button id="publicationReviewBtn" class="btn ghost" type="button">Não, revisar</button>
          <button id="publicationConfirmBtn" class="btn primary" type="button">Sim, publicar</button>
        </div>
      </div>
    `);

    let settled=false;
    const finish=(value)=>{
      if(settled) return;
      settled=true;
      closeAdvisorModal();
      resolve(value);
    };

    $("#publicationConfirmBtn")?.addEventListener("click",()=>finish(true),{once:true});
    $("#publicationReviewBtn")?.addEventListener("click",()=>finish(false),{once:true});
    $("#publicationReviewClose")?.addEventListener("click",()=>finish(false),{once:true});
  });
}

async function runPropertySave(form){
  if(!form) return;

  const submit=form.querySelector("[data-publish-property]");
  const originalText=submit?.textContent||"";

  if(!form.checkValidity()){
    const invalid=form.querySelector(":invalid");
    const label=invalid?.closest("label");
    const fieldName=(label?.childNodes?.[0]?.textContent||"campo obrigatório").trim();
    const msg=form.querySelector("#advisorPropertyMessage");
    if(msg) msg.textContent="Revise o campo: "+fieldName+".";
    invalid?.scrollIntoView({behavior:"smooth",block:"center"});
    setTimeout(()=>invalid?.reportValidity(),250);
    return;
  }

  const existingId=form.querySelector('input[name="id"]')?.value||"";

  if(!existingId){
    const confirmed=await confirmFirstPropertyPublication();
    if(!confirmed){
      const msg=form.querySelector("#advisorPropertyMessage");
      if(msg) msg.textContent="Revise os dados do imóvel e toque em Publicar imóvel quando estiver pronto.";
      form.querySelector('[name="title"]')?.scrollIntoView({behavior:"smooth",block:"center"});
      return;
    }
  }

  if(submit){
    submit.disabled=true;
    submit.textContent=existingId?"Salvando...":"Publicando...";
  }

  try{
    await saveProperty(form);
  }catch(err){
    console.error("Falha inesperada ao salvar imóvel:",err);
    const msg=form.querySelector("#advisorPropertyMessage");
    if(msg) msg.textContent="Não foi possível concluir: "+(err?.message||"erro inesperado");
  }finally{
    if(document.body.contains(form) && submit){
      submit.disabled=false;
      submit.textContent=originalText;
    }
  }
}

$("#advisorPropertyPage")?.addEventListener("submit",e=>{
  // Evita qualquer submit nativo acidental.
  if(e.target.id==="advisorPropertyForm") e.preventDefault();
});

$("#forgotPasswordBtn").addEventListener("click",async()=>{
  const email=$("#advisorLoginEmail").value.trim();
  const msg=$("#advisorAuthMessage");
  if(!email){
    msg.textContent="Digite seu e-mail primeiro para receber o link de recuperação.";
    $("#advisorLoginEmail").focus();
    return;
  }
  msg.textContent="Enviando link de recuperação...";
  const redirectTo=location.origin + location.pathname + "?type=recovery";
  const {error}=await db.auth.resetPasswordForEmail(email,{redirectTo});
  if(error){
    msg.textContent=error.message;
    return;
  }
  msg.textContent="Se esse e-mail estiver cadastrado, enviaremos um link para redefinir sua senha.";
});

$("#advisorResetPasswordForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const password=$("#advisorNewPassword").value;
  const confirm=$("#advisorConfirmPassword").value;
  const msg=$("#advisorResetMessage");

  if(password.length<6){
    msg.textContent="A nova senha deve ter pelo menos 6 caracteres.";
    return;
  }
  if(password!==confirm){
    msg.textContent="As senhas não coincidem.";
    return;
  }

  msg.textContent="Salvando nova senha...";
  const {error}=await db.auth.updateUser({password});
  if(error){
    msg.textContent=error.message;
    return;
  }

  msg.textContent="Senha alterada com sucesso. Você já pode entrar com a nova senha.";
  setTimeout(async()=>{
    await db.auth.signOut();
    location.href="assessor.html";
  },1200);
});

let authObserverRegistered=false;
function registerAuthObserver(){
  if(authObserverRegistered) return;
  authObserverRegistered=true;

  db.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY"){
      $("#advisorBootLoader")?.classList.add("hidden");
      $("#advisorAuth").classList.add("hidden");
      $("#advisorPanel").classList.add("hidden");
      $("#advisorResetPassword").classList.remove("hidden");
    }

    if(event==="SIGNED_OUT"){
      currentUser=null;
    }
  });
}

$("#advisorLoginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=$("#advisorAuthMessage");
  const email=$("#advisorLoginEmail").value.trim();
  const password=$("#advisorLoginPassword").value;

  msg.textContent="Entrando...";

  try{
    const {data,error}=await db.auth.signInWithPassword({email,password});

    if(error){
      msg.textContent="Não foi possível entrar: "+error.message;
      return;
    }

    if(!data?.user){
      msg.textContent="Login realizado, mas o usuário não foi identificado. Atualize a página e tente novamente.";
      return;
    }

    msg.textContent="";
    await enterAdvisorPanel(data.user);
  }catch(err){
    console.error("Erro no login do assessor:",err);
    msg.textContent="O login foi processado, mas ocorreu um erro ao abrir o painel. Atualize a página e tente novamente.";
  }
});

$("#advisorSignupForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=$("#advisorAuthMessage");msg.textContent="Criando conta...";
  const meta={
    full_name:$("#advisorSignupName").value.trim(),
    company_name:$("#advisorSignupCompany").value.trim(),
    whatsapp:$("#advisorSignupWhatsapp").value.replace(/\D/g,""),
    city:$("#advisorSignupCity").value.trim()
  };
  const {data,error}=await db.auth.signUp({
    email:$("#advisorSignupEmail").value.trim(),
    password:$("#advisorSignupPassword").value,
    options:{data:meta}
  });
  if(error){msg.textContent=error.message;return;}
  if(data.session && data.user){
    msg.textContent="";
    await enterAdvisorPanel(data.user);
  }else{
    msg.textContent="A conta foi criada, mas a sessão não foi iniciada. Tente entrar com o mesmo e-mail e senha.";
    document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b.dataset.authTab==="login"));
    $("#advisorLoginForm").classList.remove("hidden");
    $("#advisorSignupForm").classList.add("hidden");
    $("#advisorLoginEmail").value=$("#advisorSignupEmail").value.trim();
  }
});

$("#advisorBootRetry")?.addEventListener("click",()=>boot());

$("#advisorBootLogin")?.addEventListener("click",()=>{
  try{
    const prefix="sb-jljkpeoxisljrseqjhgm-auth-token";
    Object.keys(localStorage).forEach(key=>{
      if(key.includes(prefix)) localStorage.removeItem(key);
    });
    Object.keys(sessionStorage).forEach(key=>{
      if(key.includes(prefix)) sessionStorage.removeItem(key);
    });
  }catch(err){
    console.warn("Não foi possível limpar o armazenamento local:",err);
  }

  currentUser=null;
  $("#advisorBootLoader")?.classList.add("hidden");
  $("#advisorPanel").classList.add("hidden");
  $("#advisorResetPassword").classList.add("hidden");
  $("#advisorAuth").classList.remove("hidden");
  $("#advisorAuthMessage").textContent="Sessão deste navegador limpa. Entre novamente.";
});

$("#advisorLogout").addEventListener("click",async()=>{
  try{
    await withTimeout(db.auth.signOut(),7000,"Saída da conta");
  }catch(err){
    console.warn("Falha ao encerrar sessão pelo SDK:",err);
    try{
      const prefix="sb-jljkpeoxisljrseqjhgm-auth-token";
      Object.keys(localStorage).forEach(key=>{
        if(key.includes(prefix)) localStorage.removeItem(key);
      });
    }catch{}
  }
  location.reload();
});

boot().finally(()=>registerAuthObserver());