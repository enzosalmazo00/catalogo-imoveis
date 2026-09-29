import { advisorDb as db, STORAGE_BUCKET } from "./config.js?v=202609282145";
import { $, escapeHTML, money, propertyTypeLabel, statusLabel } from "./common.js?v=202609281430";

let currentUser=null;
let profile=null;
let plans=[];
let subscriptions=[];
let creditBatches=[];
let properties=[];
let features=[];
let referencePoints=[];
let rentalControls=[];
let advisorOwners=[];
let serviceReceipts=[];
let financialEntries=[];
let advisorDirectory=[];
let listingCollaborations=[];
let unreadCollaborationNotifications=0;
let paymentWatcher=null;
let paymentRequestInFlight=false;
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
        .select("*, property_media(*), property_features(feature_id), property_reference_points(reference_point_id)")
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
      db.from("reference_points")
        .select("*")
        .eq("active",true)
        .order("sort_order")
        .order("name"),
      8000,
      "Carregamento dos pontos de referência"
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

  const [plRes,subRes,creditRes,adsRes,featuresRes,referenceRes,rentalRes]=results;
  plans=plRes.status==="fulfilled"?(plRes.value.data||[]):[];
  subscriptions=subRes.status==="fulfilled"?(subRes.value.data||[]):[];
  creditBatches=creditRes.status==="fulfilled"?(creditRes.value.data||[]):[];
  properties=adsRes.status==="fulfilled"?(adsRes.value.data||[]):[];
  features=featuresRes.status==="fulfilled"?(featuresRes.value.data||[]):[];
  referencePoints=referenceRes.status==="fulfilled"?(referenceRes.value.data||[]):[];
  rentalControls=rentalRes.status==="fulfilled"?(rentalRes.value.data||[]):[];

  const managementResults=await Promise.allSettled([
    withTimeout(
      db.from("advisor_owners")
        .select("*")
        .eq("advisor_id",currentUser.id)
        .order("full_name"),
      8000,
      "Carregamento dos proprietários"
    ),
    withTimeout(
      db.from("advisor_service_receipts")
        .select("*")
        .eq("advisor_id",currentUser.id)
        .order("issued_at",{ascending:false}),
      8000,
      "Carregamento dos recibos de assessoria"
    ),
    withTimeout(
      db.from("advisor_financial_entries")
        .select("*")
        .eq("advisor_id",currentUser.id)
        .order("entry_date",{ascending:false})
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento financeiro"
    )
  ]);

  advisorOwners=managementResults[0].status==="fulfilled"?(managementResults[0].value.data||[]):[];
  serviceReceipts=managementResults[1].status==="fulfilled"?(managementResults[1].value.data||[]):[];
  financialEntries=managementResults[2].status==="fulfilled"?(managementResults[2].value.data||[]):[];

  const collaborationResults=await Promise.allSettled([
    withTimeout(
      db.from("advisor_directory")
        .select("user_id,full_name,company_name,city")
        .order("full_name"),
      8000,
      "Carregamento dos assessores cadastrados"
    ),
    withTimeout(
      db.from("advisor_collaborations")
        .select("*, advisor_collaboration_participants(*)")
        .eq("owner_advisor_id",currentUser.id)
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento das coassessorias"
    ),
    withTimeout(
      db.from("advisor_notifications")
        .select("id",{count:"exact",head:true})
        .eq("advisor_id",currentUser.id)
        .is("read_at",null),
      8000,
      "Carregamento das notificações"
    )
  ]);

  advisorDirectory=collaborationResults[0].status==="fulfilled"?(collaborationResults[0].value.data||[]):[];
  listingCollaborations=collaborationResults[1].status==="fulfilled"?(collaborationResults[1].value.data||[]):[];
  unreadCollaborationNotifications=collaborationResults[2].status==="fulfilled"?Number(collaborationResults[2].value.count||0):0;

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
  const superPlan=plans.find(plan=>plan.code==="super_20");

  const superHtml=superPlan?(()=>{
    const unit=Number(superPlan.price)/Math.max(1,Number(superPlan.ad_limit||1));
    const avulso=Number(superPlan.ad_limit||0)*9.99;
    const saving=Math.max(0,avulso-Number(superPlan.price));

    return `
      <article class="advisor-premium-plan-card">
        <div class="premium-plan-shine"></div>
        <div class="premium-plan-topline">
          <span class="premium-plan-badge">⭐ PREMIUM</span>
          <span class="premium-plan-value-badge">MAIOR DESCONTO</span>
        </div>

        <div class="premium-plan-content">
          <div class="premium-plan-copy">
            <p class="eyebrow">PARA QUEM ANUNCIA COM FREQUÊNCIA</p>
            <h3>Premium 20 créditos</h3>
            <p class="premium-plan-lead">20 anúncios por R$ 99,90 — aproximadamente R$ 5,00 por anúncio.</p>

            <div class="premium-plan-features">
              <span>✓ 20 créditos de anúncio</span>
              <span>✓ Só ${money(unit,"BRL")} por crédito</span>
              <span>✓ Cada crédito publica 1 imóvel por 30 dias</span>
              <span>✓ Créditos não usados válidos por ${Number(superPlan.validity_days||120)} dias</span>
            </div>
          </div>

          <div class="premium-plan-price-box">
            <small>20 créditos</small>
            <strong>${money(superPlan.price,"BRL")}</strong>

            <div class="premium-plan-comparison">
              <span>Avulso equivalente: <s>${money(avulso,"BRL")}</s></span>
              <strong>Economize ${money(saving,"BRL")}</strong>
            </div>

            <div class="premium-plan-unit-price">
              Só <strong>${money(unit,"BRL")}</strong> por anúncio
            </div>

            <button class="btn premium-plan-button full" data-buy="${superPlan.id}">Comprar Premium</button>
            <small class="premium-plan-payment-note">Pagamento via PIX</small>
          </div>
        </div>
      </article>
    `;
  })():"";

  $("#advisorPlans").innerHTML=`
    ${superHtml}
    <div class="credit-store-entry">
      <span>Quer menos créditos?</span>
      <button class="btn ghost" type="button" data-open-credit-store>Ver pacotes a partir de R$ 9,99</button>
    </div>
  `;
}

function renderCreditStore(){
  const standardPlans=plans.filter(plan=>plan.code!=="super_20");
  const root=$("#advisorCreditStorePlans");
  if(!root) return;

  const standardHtml=standardPlans.map(plan=>{
    const unit=Number(plan.price)/Math.max(1,Number(plan.ad_limit||1));
    return `
      <article class="advisor-plan-card credit-store-plan-card">
        <span class="advisor-plan-badge">${plan.ad_limit} crédito${plan.ad_limit>1?"s":""}</span>
        <h3>${escapeHTML(plan.name)}</h3>
        <div class="advisor-plan-price">${money(plan.price,"BRL")}</div>
        <div class="advisor-plan-unit">${money(unit,"BRL")} por crédito</div>
        <p>Créditos não usados válidos por <strong>${Number(plan.validity_days||90)} dias</strong>.</p>
        <small>Cada crédito publica 1 imóvel por 30 dias.</small>
        <button class="btn primary full" data-buy="${plan.id}">Comprar via PIX</button>
      </article>`;
  }).join("");

  root.innerHTML=standardHtml || '<div class="empty-state"><strong>Nenhuma outra opção disponível no momento.</strong></div>';
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
  const reminder=`
    <div class="advisor-expired-alert">
      <strong>⚠️ Imóvel alugado? Marque imediatamente.</strong>
      <span>Use o botão “Marcar como alugado”. O recibo é obrigatório. Depois da confirmação, o anúncio, as fotos e as demais mídias serão excluídos; somente os dados do recibo ficarão salvos.</span>
    </div>`;

  if(!properties.length){
    $("#advisorAds").innerHTML=reminder+'<div class="empty-state"><strong>Nenhum anúncio publicado ainda.</strong><span>Compre créditos e use 1 crédito para ativar seu primeiro imóvel por 30 dias.</span></div>';
    return;
  }

  const balance=creditBalance();

  $("#advisorAds").innerHTML=`
    ${reminder}
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
              <small><strong>👁 ${Number(p.view_count||0).toLocaleString("pt-BR")}</strong> visualizações • <strong>💬 ${Number(p.whatsapp_click_count||0).toLocaleString("pt-BR")}</strong> contatos pelo WhatsApp</small>
            </div>
            <div class="advisor-ad-actions">
              <span class="pill ${expired?"pending":"paid"}">${expired?"FORA DO AR":"ATIVO"}</span>
              ${expired
                ? (balance>0
                    ? `<button class="btn primary compact" data-reactivate-ad="${p.id}">Reativar • 1 crédito</button>`
                    : '<button class="btn ghost compact" type="button" disabled>Sem crédito para reativar</button>')
                : `<button class="btn ghost compact" data-edit-ad="${p.id}">Editar</button>`
              }
              <button class="btn primary compact" data-mark-rented-ad="${p.id}">✓ Marcar como alugado</button>
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

function paymentStatusText(paid,date){
  if(!paid) return "Pendente";
  return date ? `Pago em ${dateOnlyBR(date)}` : "Pago";
}


function ownerById(id){
  return advisorOwners.find(owner=>owner.id===id)||null;
}

function ownerMatchesRental(owner,row){
  if(!owner || !row) return false;
  if(row.advisor_owner_id && row.advisor_owner_id===owner.id) return true;
  return String(row.owner_name||"").trim().toLocaleLowerCase("pt-BR")===String(owner.full_name||"").trim().toLocaleLowerCase("pt-BR");
}

function ownerOptions(selectedId="",includeBlank=true){
  return [
    includeBlank?'<option value="">Selecione um proprietário</option>':"",
    ...advisorOwners.map(owner=>`<option value="${owner.id}" ${owner.id===selectedId?"selected":""}>${escapeHTML(owner.full_name)}${owner.whatsapp?` • ${escapeHTML(owner.whatsapp)}`:""}</option>`)
  ].join("");
}

function totalServiceReceipt(row){
  return ["commission_amount","advisory_fee_amount","contract_amount","other_amount"]
    .reduce((sum,key)=>sum+Number(row?.[key]||0),0);
}

function financialRecords(){
  const rows=[];

  rentalControls.forEach(r=>{
    const base={
      property_id:r.property_id||null,
      property_code:r.property_code||null,
      property_title:r.property_title||"Imóvel alugado",
      currency:r.currency||"BRL"
    };
    if(Number(r.commission_amount||0)>0){
      rows.push({
        ...base,
        id:`rental-commission-${r.id}`,
        source:"Locação",
        description:"Comissão do assessor",
        category:"commission",
        entry_type:"income",
        amount:Number(r.commission_amount||0),
        status:r.commission_paid?"paid":"pending",
        date:r.advisor_commission_payment_date||r.start_date||r.created_at
      });
    }
    if(Number(r.advisory_fee_amount||0)>0){
      rows.push({
        ...base,
        id:`rental-advisory-${r.id}`,
        source:"Locação",
        description:"Taxa de assessoria",
        category:"advisory",
        entry_type:"income",
        amount:Number(r.advisory_fee_amount||0),
        status:r.advisory_fee_paid?"paid":"pending",
        date:r.advisory_fee_payment_date||r.start_date||r.created_at
      });
    }
  });

  serviceReceipts.filter(r=>r.include_in_financials).forEach(r=>{
    const base={
      property_id:r.property_id||null,
      property_code:r.property_code||null,
      property_title:r.property_title||"Serviço de assessoria",
      currency:r.currency||"BRL",
      source:"Recibo",
      entry_type:"income",
      status:r.paid?"paid":"pending",
      date:r.payment_date||r.issued_at
    };
    [
      ["commission_amount","Comissão","commission"],
      ["advisory_fee_amount","Taxa de assessoria","advisory"],
      ["contract_amount","Contrato / documentação","documents"],
      ["other_amount","Outros valores","other"]
    ].forEach(([field,label,category])=>{
      const amount=Number(r[field]||0);
      if(amount<=0) return;
      rows.push({
        ...base,
        id:`service-${category}-${r.id}`,
        description:`${label} • ${r.service_description||"Recibo de assessoria"}`,
        category,
        amount
      });
    });
  });

  financialEntries.forEach(r=>{
    const property=properties.find(p=>p.id===r.property_id);
    rows.push({
      id:`entry-${r.id}`,
      raw_id:r.id,
      property_id:r.property_id||null,
      property_code:r.property_code||property?.public_code||null,
      property_title:r.property_title||property?.title||"Sem imóvel vinculado",
      currency:r.currency||"BRL",
      source:"Lançamento",
      description:r.description,
      entry_type:r.entry_type,
      amount:Number(r.amount||0),
      status:r.status,
      date:r.entry_date||r.created_at,
      category:r.category
    });
  });

  return rows;
}

function blankCurrencyTotals(){
  return {BRL:0,PYG:0};
}

function addCurrencyValue(totals,currency,value){
  const key=currency==="PYG"?"PYG":"BRL";
  totals[key]=(totals[key]||0)+Number(value||0);
  return totals;
}

function formatCurrencyTotals(totals){
  const parts=[];
  if(Number(totals.BRL||0)!==0) parts.push(money(totals.BRL,"BRL"));
  if(Number(totals.PYG||0)!==0) parts.push(money(totals.PYG,"PYG"));
  return parts.length?parts.join(" • "):money(0,"BRL");
}

function renderManagementDashboard(){
  const root=$("#advisorManagementDashboard");
  if(!root) return;

  const now=Date.now();
  const fiveDays=5*24*60*60*1000;
  const active=properties.filter(p=>p.is_published && p.status==="available" && p.listing_expires_at && new Date(p.listing_expires_at).getTime()>now);
  const expired=properties
    .filter(p=>!p.is_published || !p.listing_expires_at || new Date(p.listing_expires_at).getTime()<=now)
    .sort((a,b)=>new Date(b.listing_expires_at||0)-new Date(a.listing_expires_at||0));
  const expiring=active
    .filter(p=>new Date(p.listing_expires_at).getTime()<=now+fiveDays)
    .sort((a,b)=>new Date(a.listing_expires_at)-new Date(b.listing_expires_at));
  const totalViews=properties.reduce((sum,p)=>sum+Number(p.view_count||0),0);
  const whatsapp=properties.reduce((sum,p)=>sum+Number(p.whatsapp_click_count||0),0);
  const topViewed=[...properties]
    .sort((a,b)=>Number(b.view_count||0)-Number(a.view_count||0))
    .slice(0,5);
  const records=financialRecords();
  const received=blankCurrencyTotals();
  const pending=blankCurrencyTotals();
  const expenses=blankCurrencyTotals();

  records.forEach(r=>{
    if(r.entry_type==="income" && r.status==="paid") addCurrencyValue(received,r.currency,r.amount);
    if(r.entry_type==="income" && r.status==="pending") addCurrencyValue(pending,r.currency,r.amount);
    if(r.entry_type==="expense" && r.status==="paid") addCurrencyValue(expenses,r.currency,r.amount);
  });

  const result={
    BRL:Number(received.BRL||0)-Number(expenses.BRL||0),
    PYG:Number(received.PYG||0)-Number(expenses.PYG||0)
  };

  root.innerHTML=`
    <section class="advisor-management-hero">
      <div class="advisor-management-title">
        <div>
          <p class="eyebrow">CENTRAL DE GESTÃO</p>
          <h2>Visão geral da sua operação</h2>
          <p>Acompanhe anúncios, desempenho, locações, proprietários e resultado financeiro sem sair do painel.</p>
        </div>
      </div>

      <div class="advisor-kpi-grid">
        <article><span>Anúncios ativos</span><strong>${active.length}</strong><small>${expired.length} expirado${expired.length===1?"":"s"}</small></article>
        <article class="${expiring.length?"attention":""}"><span>Vencem em até 5 dias</span><strong>${expiring.length}</strong><small>renove antes de sair do ar</small></article>
        <article><span>Imóveis alugados</span><strong>${rentalControls.length}</strong><small>registros de locação</small></article>
        <article><span>Visualizações</span><strong>${totalViews.toLocaleString("pt-BR")}</strong><small>${whatsapp.toLocaleString("pt-BR")} cliques no WhatsApp</small></article>
        <article><span>Proprietários</span><strong>${advisorOwners.length}</strong><small>na sua carteira</small></article>
        <article class="money"><span>Receita recebida</span><strong>${formatCurrencyTotals(received)}</strong><small>A receber: ${formatCurrencyTotals(pending)}</small></article>
        <article class="money"><span>Despesas pagas</span><strong>${formatCurrencyTotals(expenses)}</strong><small>lançamentos financeiros</small></article>
        <article class="money result"><span>Resultado líquido</span><strong>${formatCurrencyTotals(result)}</strong><small>receitas recebidas − despesas</small></article>
      </div>

      <div class="advisor-dashboard-columns">
        <section class="advisor-dashboard-box">
          <div class="advisor-dashboard-box-head">
            <div><p class="eyebrow">PRAZOS</p><h3>Próximos vencimentos</h3></div>
          </div>
          ${expiring.length?`
            <div class="advisor-deadline-list">
              ${expiring.map(p=>{
                const ms=new Date(p.listing_expires_at).getTime()-now;
                const days=Math.max(0,Math.ceil(ms/(24*60*60*1000)));
                return `<div><span><strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong><small>${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))}</small></span><b>${days===0?"Hoje":days===1?"1 dia":`${days} dias`}</b></div>`;
              }).join("")}
            </div>
          `:'<div class="advisor-empty-compact">Nenhum anúncio vence nos próximos 5 dias.</div>'}
          ${expired.length?`
            <div class="advisor-expired-mini-title">Já expirados</div>
            <div class="advisor-deadline-list expired">
              ${expired.slice(0,5).map(p=>`
                <div>
                  <span><strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong><small>Venceu em ${p.listing_expires_at?dateOnlyBR(p.listing_expires_at):"data não informada"}</small></span>
                  <b>Expirado</b>
                </div>
              `).join("")}
            </div>
            ${expired.length>5?`<small class="advisor-deadline-more">+ ${expired.length-5} anúncio${expired.length-5===1?"":"s"} expirado${expired.length-5===1?"":"s"} em “Meus anúncios”.</small>`:""}
          `:""}
        </section>

        <section class="advisor-dashboard-box">
          <div class="advisor-dashboard-box-head">
            <div><p class="eyebrow">DESEMPENHO</p><h3>Imóveis mais vistos</h3></div>
          </div>
          ${topViewed.length?`
            <div class="advisor-performance-list">
              ${topViewed.map((p,index)=>`
                <div>
                  <span class="rank">${index+1}</span>
                  <span class="info"><strong>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</strong><small>💬 ${Number(p.whatsapp_click_count||0).toLocaleString("pt-BR")} contatos</small></span>
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
  const root=$("#advisorOwnersList");
  if(!root) return;

  if(!advisorOwners.length){
    root.innerHTML='<div class="empty-state"><strong>Nenhum proprietário cadastrado.</strong><span>Cadastre o proprietário uma vez e vincule os imóveis assessorados a ele.</span></div>';
    return;
  }

  root.innerHTML=`
    <div class="advisor-owner-grid">
      ${advisorOwners.map(owner=>{
        const ownerProperties=properties.filter(p=>p.advisor_owner_id===owner.id);
        const ownerRentals=rentalControls.filter(r=>ownerMatchesRental(owner,r));
        const active=ownerProperties.filter(p=>p.is_published && p.listing_expires_at && new Date(p.listing_expires_at)>new Date()).length;
        const expired=ownerProperties.length-active;
        const ownerViews=ownerProperties.reduce((sum,p)=>sum+Number(p.view_count||0),0);
        const ownerWhatsapp=ownerProperties.reduce((sum,p)=>sum+Number(p.whatsapp_click_count||0),0);
        const phone=String(owner.whatsapp||"").replace(/\D/g,"");
        return `
          <article class="advisor-owner-card">
            <div class="advisor-owner-card-head">
              <div>
                <p class="eyebrow">PROPRIETÁRIO</p>
                <h3>${escapeHTML(owner.full_name)}</h3>
                <span>${escapeHTML(owner.whatsapp||"WhatsApp não informado")}</span>
              </div>
              <div class="table-actions">
                <button class="btn ghost compact" type="button" data-edit-owner="${owner.id}">Editar</button>
                <button class="btn danger compact" type="button" data-delete-owner="${owner.id}">Excluir</button>
              </div>
            </div>
            <div class="advisor-owner-stats">
              <div><span>Imóveis</span><strong>${ownerProperties.length}</strong></div>
              <div><span>Ativos</span><strong>${active}</strong></div>
              <div><span>Expirados</span><strong>${expired}</strong></div>
              <div><span>Alugados</span><strong>${ownerRentals.length}</strong></div>
              <div><span>Visualizações</span><strong>${ownerViews.toLocaleString("pt-BR")}</strong></div>
              <div><span>WhatsApp</span><strong>${ownerWhatsapp.toLocaleString("pt-BR")}</strong></div>
            </div>
            <div class="advisor-owner-contact">
              ${owner.document?`<span>Documento: ${escapeHTML(owner.document)}</span>`:""}
              ${phone?`<a class="btn whatsapp compact" href="https://wa.me/${phone}" target="_blank" rel="noopener">💬 WhatsApp</a>`:""}
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function ownerModal(row=null){
  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">PROPRIETÁRIO</p>
        <h2>${row?"Editar proprietário":"Cadastrar proprietário"}</h2>
        <p class="muted">Esses dados ficam privados na área do assessor e não aparecem no catálogo público.</p>
      </div>
      <button class="icon-btn" type="button" data-close>✕</button>
    </div>
    <form id="advisorOwnerForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label class="span-2">Nome completo
        <input name="full_name" required value="${escapeHTML(row?.full_name||"")}" autocomplete="name">
      </label>
      <label class="span-2">WhatsApp
        <input name="whatsapp" required inputmode="tel" value="${escapeHTML(row?.whatsapp||"")}" placeholder="Ex.: 595981123456">
      </label>
      <div id="advisorOwnerMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar proprietário</button>
      </div>
    </form>
  `);
}

async function saveOwner(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const msg=form.querySelector("#advisorOwnerMessage");
  const row={
    advisor_id:currentUser.id,
    full_name:String(fd.get("full_name")||"").trim(),
    whatsapp:String(fd.get("whatsapp")||"").replace(/\D/g,"").trim(),
    updated_at:new Date().toISOString()
  };

  if(!row.full_name || !row.whatsapp){
    if(msg) msg.textContent="Informe nome e WhatsApp do proprietário.";
    return;
  }

  const result=id
    ? await db.from("advisor_owners").update(row).eq("id",id).eq("advisor_id",currentUser.id).select("*").single()
    : await db.from("advisor_owners").insert(row).select("*").single();

  if(result.error){
    if(msg) msg.textContent=result.error.message;
    return;
  }

  await loadData();
  closeAdvisorModal();
  renderOwners();
  renderManagementDashboard();

  const select=$("#advisorPropertyForm")?.querySelector('[name="advisor_owner_id"]');
  if(select){
    select.innerHTML=ownerOptions(result.data?.id||id||"");
    select.value=result.data?.id||id||"";
  }
}

function renderFinance(){
  const root=$("#advisorFinanceContent");
  if(!root) return;

  const records=financialRecords();
  const received=blankCurrencyTotals();
  const pending=blankCurrencyTotals();
  const expenses=blankCurrencyTotals();
  const pendingExpenses=blankCurrencyTotals();
  const commissionsReceived=blankCurrencyTotals();
  const advisoryReceived=blankCurrencyTotals();

  records.forEach(r=>{
    if(r.entry_type==="income" && r.status==="paid") addCurrencyValue(received,r.currency,r.amount);
    if(r.entry_type==="income" && r.status==="pending") addCurrencyValue(pending,r.currency,r.amount);
    if(r.entry_type==="expense" && r.status==="paid") addCurrencyValue(expenses,r.currency,r.amount);
    if(r.entry_type==="expense" && r.status==="pending") addCurrencyValue(pendingExpenses,r.currency,r.amount);
    if(r.entry_type==="income" && r.status==="paid" && r.category==="commission") addCurrencyValue(commissionsReceived,r.currency,r.amount);
    if(r.entry_type==="income" && r.status==="paid" && r.category==="advisory") addCurrencyValue(advisoryReceived,r.currency,r.amount);
  });

  const result={
    BRL:Number(received.BRL||0)-Number(expenses.BRL||0),
    PYG:Number(received.PYG||0)-Number(expenses.PYG||0)
  };

  const grouped=new Map();
  records.forEach(r=>{
    const key=r.property_id || `${r.property_code||""}|${r.property_title||"Sem imóvel"}`;
    if(!grouped.has(key)){
      grouped.set(key,{
        code:r.property_code||"—",
        title:r.property_title||"Sem imóvel vinculado",
        received:blankCurrencyTotals(),
        pending:blankCurrencyTotals(),
        expenses:blankCurrencyTotals()
      });
    }
    const g=grouped.get(key);
    if(r.entry_type==="income" && r.status==="paid") addCurrencyValue(g.received,r.currency,r.amount);
    if(r.entry_type==="income" && r.status==="pending") addCurrencyValue(g.pending,r.currency,r.amount);
    if(r.entry_type==="expense" && r.status==="paid") addCurrencyValue(g.expenses,r.currency,r.amount);
  });

  root.innerHTML=`
    <div class="advisor-finance-summary">
      <article><span>Comissões recebidas</span><strong>${formatCurrencyTotals(commissionsReceived)}</strong><small>Comissões marcadas como pagas</small></article>
      <article><span>Assessoria recebida</span><strong>${formatCurrencyTotals(advisoryReceived)}</strong><small>Taxas de assessoria pagas</small></article>
      <article><span>Receita recebida</span><strong>${formatCurrencyTotals(received)}</strong><small>Todas as receitas contabilizadas</small></article>
      <article><span>A receber</span><strong>${formatCurrencyTotals(pending)}</strong><small>Receitas pendentes</small></article>
      <article><span>Despesas pagas</span><strong>${formatCurrencyTotals(expenses)}</strong><small>Pendentes: ${formatCurrencyTotals(pendingExpenses)}</small></article>
      <article class="result"><span>Resultado líquido</span><strong>${formatCurrencyTotals(result)}</strong><small>Receitas recebidas − despesas pagas</small></article>
    </div>

    <div class="advisor-finance-columns">
      <section class="advisor-dashboard-box">
        <div class="advisor-dashboard-box-head"><div><p class="eyebrow">POR IMÓVEL</p><h3>Resultado consolidado</h3></div></div>
        ${grouped.size?`
          <div class="admin-table-wrap">
            <table class="admin-table advisor-finance-property-table">
              <thead><tr><th>Imóvel</th><th>Recebido</th><th>A receber</th><th>Despesas</th><th>Resultado</th></tr></thead>
              <tbody>
                ${[...grouped.values()].map(g=>{
                  const net={BRL:g.received.BRL-g.expenses.BRL,PYG:g.received.PYG-g.expenses.PYG};
                  return `<tr>
                    <td><strong>${escapeHTML(g.code)}</strong><br><span class="muted">${escapeHTML(g.title)}</span></td>
                    <td>${formatCurrencyTotals(g.received)}</td>
                    <td>${formatCurrencyTotals(g.pending)}</td>
                    <td>${formatCurrencyTotals(g.expenses)}</td>
                    <td><strong>${formatCurrencyTotals(net)}</strong></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
        `:'<div class="advisor-empty-compact">Ainda não há movimentação financeira vinculada a imóveis.</div>'}
      </section>

      <section class="advisor-dashboard-box">
        <div class="advisor-dashboard-box-head"><div><p class="eyebrow">MOVIMENTAÇÕES</p><h3>Todos os lançamentos</h3></div></div>
        ${records.length?`
          <div class="admin-table-wrap">
            <table class="admin-table advisor-finance-ledger">
              <thead><tr><th>Data</th><th>Descrição</th><th>Imóvel</th><th>Tipo</th><th>Status</th><th>Valor</th><th></th></tr></thead>
              <tbody>
                ${records.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0)).map(r=>`
                  <tr>
                    <td>${dateOnlyBR(r.date)}</td>
                    <td><strong>${escapeHTML(r.description||"Lançamento")}</strong><br><span class="muted">${escapeHTML(r.source||"")}</span></td>
                    <td>${escapeHTML(r.property_code||"—")}<br><span class="muted">${escapeHTML(r.property_title||"")}</span></td>
                    <td><span class="pill ${r.entry_type==="expense"?"expense":"paid"}">${r.entry_type==="expense"?"Despesa":"Receita"}</span></td>
                    <td><span class="pill ${r.status==="paid"?"paid":"pending"}">${r.status==="paid"?"Pago":"Pendente"}</span></td>
                    <td><strong>${money(r.amount,r.currency)}</strong></td>
                    <td>${r.raw_id?`<div class="table-actions"><button class="btn ghost compact" data-edit-financial-entry="${r.raw_id}">Editar</button><button class="btn danger compact" data-delete-financial-entry="${r.raw_id}">Excluir</button></div>`:""}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `:'<div class="advisor-empty-compact">Nenhuma movimentação registrada.</div>'}
      </section>
    </div>
  `;
}

function financialEntryModal(row=null){
  const propertiesOptions=properties.map(p=>`<option value="${p.id}" ${row?.property_id===p.id?"selected":""}>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</option>`).join("");
  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">GESTÃO FINANCEIRA</p>
        <h2>${row?"Editar lançamento":"Novo lançamento"}</h2>
        <p class="muted">Use para despesas e receitas extras. Comissões e taxas registradas nas locações entram automaticamente.</p>
      </div>
      <button class="icon-btn" type="button" data-close>✕</button>
    </div>
    <form id="advisorFinancialEntryForm" class="form-grid">
      <input type="hidden" name="id" value="${row?.id||""}">
      <label>Tipo
        <select name="entry_type" required>
          <option value="income" ${(row?.entry_type||"income")==="income"?"selected":""}>Receita</option>
          <option value="expense" ${row?.entry_type==="expense"?"selected":""}>Despesa</option>
        </select>
      </label>
      <label>Status
        <select name="status" required>
          <option value="paid" ${(row?.status||"paid")==="paid"?"selected":""}>Pago / recebido</option>
          <option value="pending" ${row?.status==="pending"?"selected":""}>Pendente</option>
        </select>
      </label>
      <label class="span-2">Imóvel vinculado
        <select name="property_id"><option value="">Sem imóvel específico</option>${propertiesOptions}</select>
      </label>
      <label>Categoria
        <select name="category">
          <option value="other" ${(row?.category||"other")==="other"?"selected":""}>Outro</option>
          <option value="advertising" ${row?.category==="advertising"?"selected":""}>Publicidade / anúncio</option>
          <option value="transport" ${row?.category==="transport"?"selected":""}>Deslocamento</option>
          <option value="documents" ${row?.category==="documents"?"selected":""}>Documentos</option>
          <option value="commission" ${row?.category==="commission"?"selected":""}>Comissão</option>
          <option value="advisory" ${row?.category==="advisory"?"selected":""}>Assessoria</option>
        </select>
      </label>
      <label>Data
        <input name="entry_date" type="date" required value="${String(row?.entry_date||new Date().toISOString().slice(0,10)).slice(0,10)}">
      </label>
      <label class="span-2">Descrição
        <input name="description" required value="${escapeHTML(row?.description||"")}" placeholder="Ex.: combustível para visita / comissão extra">
      </label>
      <label>Moeda
        <select name="currency">
          <option value="BRL" ${(row?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${row?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>
      <label>Valor
        <input name="amount" type="number" min="0" step="1" required value="${row?.amount??""}">
      </label>
      <div id="advisorFinancialEntryMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar lançamento</button>
      </div>
    </form>
  `);
}

async function saveFinancialEntry(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const msg=form.querySelector("#advisorFinancialEntryMessage");
  const linkedProperty=properties.find(p=>p.id===String(fd.get("property_id")||""));
  const existing=id?financialEntries.find(item=>item.id===id):null;
  const row={
    advisor_id:currentUser.id,
    property_id:linkedProperty?.id||null,
    property_code:linkedProperty?.public_code||existing?.property_code||null,
    property_title:linkedProperty?.title||existing?.property_title||null,
    entry_type:fd.get("entry_type"),
    category:fd.get("category")||"other",
    description:String(fd.get("description")||"").trim(),
    amount:Number(fd.get("amount")||0),
    currency:fd.get("currency")||"BRL",
    status:fd.get("status")||"paid",
    entry_date:fd.get("entry_date"),
    updated_at:new Date().toISOString()
  };

  if(!row.description || row.amount<0){
    if(msg) msg.textContent="Informe uma descrição e um valor válido.";
    return;
  }

  const result=id
    ? await db.from("advisor_financial_entries").update(row).eq("id",id).eq("advisor_id",currentUser.id)
    : await db.from("advisor_financial_entries").insert(row);

  if(result.error){
    if(msg) msg.textContent=result.error.message;
    return;
  }

  await loadData();
  closeAdvisorModal();
  renderFinance();
  renderManagementDashboard();
}

function renderServiceReceipts(){
  const root=$("#advisorServiceReceiptsList");
  if(!root) return;

  if(!serviceReceipts.length){
    root.innerHTML='<div class="empty-state"><strong>Nenhum recibo de assessoria gerado.</strong><span>Use “Gerar recibo” quando quiser documentar um serviço ou pagamento sem encerrar o anúncio.</span></div>';
    return;
  }

  root.innerHTML=`
    <div class="admin-table-wrap">
      <table class="admin-table advisor-service-receipt-table">
        <thead><tr><th>Recibo</th><th>Imóvel</th><th>Proprietário</th><th>Cliente</th><th>Total</th><th>Pagamento</th><th>Ações</th></tr></thead>
        <tbody>
          ${serviceReceipts.map(r=>`
            <tr>
              <td><strong>${escapeHTML(r.receipt_code)}</strong><br><span class="muted">${dateOnlyBR(r.payment_date||r.issued_at)}</span></td>
              <td><strong>${escapeHTML(r.property_code||"—")}</strong><br><span class="muted">${escapeHTML(r.property_title||"Sem imóvel vinculado")}</span></td>
              <td><strong>${escapeHTML(r.owner_name||"—")}</strong><br><span class="muted">${escapeHTML(r.owner_phone||"")}</span></td>
              <td><strong>${escapeHTML(r.client_name||"—")}</strong><br><span class="muted">${escapeHTML(r.client_phone||"")}</span></td>
              <td><strong>${money(totalServiceReceipt(r),r.currency)}</strong></td>
              <td><span class="pill ${r.paid?"paid":"pending"}">${r.paid?"Recebido":"Pendente"}</span><br><span class="muted">${escapeHTML(r.payment_method||"")}</span></td>
              <td><div class="table-actions">
                <button class="btn primary compact" type="button" data-generate-service-receipt="${r.id}">PDF</button>
                <button class="btn ghost compact" type="button" data-edit-service-receipt="${r.id}">Editar</button>
                <button class="btn danger compact" type="button" data-delete-service-receipt="${r.id}">Excluir</button>
              </div></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="tiny-note">Recibos voluntários documentam os dados informados pelo assessor. Eles não encerram anúncios e não substituem contrato de locação, contrato de assessoria ou orientação jurídica.</p>
  `;
}

function serviceReceiptModal(row=null){
  const propertiesOptions=properties.map(p=>`<option value="${p.id}" ${row?.property_id===p.id?"selected":""}>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</option>`).join("");
  const ownerId=row?.advisor_owner_id||properties.find(p=>p.id===row?.property_id)?.advisor_owner_id||"";

  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">RECIBO VOLUNTÁRIO</p>
        <h2>${row?"Editar recibo":"Gerar recibo de assessoria"}</h2>
        <p class="muted">Preencha os dados completos do serviço e do pagamento. O anúncio do imóvel permanece ativo.</p>
      </div>
      <button class="icon-btn" type="button" data-close>✕</button>
    </div>

    <form id="advisorServiceReceiptForm" class="form-grid service-receipt-form">
      <input type="hidden" name="id" value="${row?.id||""}">

      <div class="form-section-title">Imóvel e proprietário</div>
      <label class="span-2">Imóvel vinculado
        <select name="property_id"><option value="">Recibo sem anúncio vinculado</option>${propertiesOptions}</select>
      </label>
      <label>Código / identificação do imóvel
        <input name="property_code" value="${escapeHTML(row?.property_code||"")}" placeholder="Ex.: IMV-000123 ou referência interna">
      </label>
      <label>Nome / descrição do imóvel
        <input name="property_title" value="${escapeHTML(row?.property_title||"")}" placeholder="Ex.: Apartamento 2 quartos">
      </label>
      <label class="span-2">Endereço do imóvel
        <input name="property_address" value="${escapeHTML(row?.property_address||"")}" placeholder="Rua, número, bairro e cidade">
      </label>
      <label class="span-2">Proprietário cadastrado
        <select name="advisor_owner_id">${ownerOptions(ownerId,true)}</select>
      </label>
      <label>Nome do proprietário
        <input name="owner_name" required value="${escapeHTML(row?.owner_name||ownerById(ownerId)?.full_name||"")}">
      </label>

      <div class="form-section-title">Cliente / inquilino</div>
      <label>Nome
        <input name="client_name" value="${escapeHTML(row?.client_name||"")}">
      </label>

      <div class="form-section-title">Serviço e valores</div>
      <label class="span-2">Descrição do serviço
        <textarea name="service_description" required rows="3">${escapeHTML(row?.service_description||"Serviço de assessoria imobiliária")}</textarea>
      </label>
      <label>Moeda
        <select name="currency">
          <option value="BRL" ${(row?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${row?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
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
      <div class="span-2 receipt-total-preview">Total do recibo: <strong id="serviceReceiptTotalPreview">—</strong></div>

      <div class="form-section-title">Pagamento</div>
      <label>Pagamento recebido?
        <select name="paid">
          <option value="true" ${row?.paid!==false?"selected":""}>Sim</option>
          <option value="false" ${row?.paid===false?"selected":""}>Ainda não</option>
        </select>
      </label>
      <label>Data do pagamento
        <input name="payment_date" type="date" value="${String(row?.payment_date||new Date().toISOString().slice(0,10)).slice(0,10)}">
      </label>
      <label>Forma de pagamento
        <select name="payment_method">
          <option value="">Selecione</option>
          <option value="PIX" ${row?.payment_method==="PIX"?"selected":""}>PIX</option>
          <option value="Dinheiro" ${row?.payment_method==="Dinheiro"?"selected":""}>Dinheiro</option>
          <option value="Transferência" ${row?.payment_method==="Transferência"?"selected":""}>Transferência bancária</option>
          <option value="Cartão" ${row?.payment_method==="Cartão"?"selected":""}>Cartão</option>
          <option value="Outro" ${row?.payment_method==="Outro"?"selected":""}>Outro</option>
        </select>
      </label>
      <label>Referência / comprovante
        <input name="payment_reference" value="${escapeHTML(row?.payment_reference||"")}" placeholder="Opcional">
      </label>
      <label class="span-2">Incluir nos totais financeiros?
        <select name="include_in_financials">
          <option value="false" ${!row?.include_in_financials?"selected":""}>Não — apenas documento</option>
          <option value="true" ${row?.include_in_financials?"selected":""}>Sim — contabilizar como receita</option>
        </select>
        <small>Use “Sim” apenas se este valor ainda não estiver registrado na locação ou em outro lançamento, para evitar duplicidade.</small>
      </label>

      <div id="advisorServiceReceiptMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar e gerar recibo</button>
      </div>
    </form>
  `);

  wireServiceReceiptForm($("#advisorServiceReceiptForm"));
}

function wireServiceReceiptForm(form){
  if(!form) return;

  const propertySelect=form.querySelector('[name="property_id"]');
  const ownerSelect=form.querySelector('[name="advisor_owner_id"]');
  const currency=form.querySelector('[name="currency"]');
  const paid=form.querySelector('[name="paid"]');
  const paymentDate=form.querySelector('[name="payment_date"]');
  const amountNames=["commission_amount","advisory_fee_amount","contract_amount","other_amount"];

  const fillOwner=(owner)=>{
    if(!owner) return;
    form.querySelector('[name="owner_name"]').value=owner.full_name||"";
    form.querySelector('[name="owner_phone"]').value=owner.whatsapp||"";
  };

  propertySelect?.addEventListener("change",()=>{
    const property=properties.find(p=>p.id===propertySelect.value);
    if(!property) return;
    const propertyCode=form.querySelector('[name="property_code"]');
    const propertyTitle=form.querySelector('[name="property_title"]');
    const propertyAddress=form.querySelector('[name="property_address"]');
    if(propertyCode) propertyCode.value=property.public_code||"";
    if(propertyTitle) propertyTitle.value=property.title||"";
    if(propertyAddress) propertyAddress.value=[property.address,property.neighborhood,property.city].filter(Boolean).join(" • ");
    if(ownerSelect && property.advisor_owner_id){
      ownerSelect.value=property.advisor_owner_id;
      fillOwner(ownerById(property.advisor_owner_id));
    }
  });

  ownerSelect?.addEventListener("change",()=>fillOwner(ownerById(ownerSelect.value)));

  const updateTotal=()=>{
    const total=amountNames.reduce((sum,name)=>sum+Number(form.querySelector(`[name="${name}"]`)?.value||0),0);
    const preview=form.querySelector("#serviceReceiptTotalPreview");
    if(preview) preview.textContent=money(total,currency?.value||"BRL");
  };
  amountNames.forEach(name=>form.querySelector(`[name="${name}"]`)?.addEventListener("input",updateTotal));
  currency?.addEventListener("change",updateTotal);

  const updatePaid=()=>{
    const isPaid=paid?.value==="true";
    if(paymentDate) paymentDate.required=isPaid;
  };
  paid?.addEventListener("change",updatePaid);
  updatePaid();
  updateTotal();
}

async function saveServiceReceipt(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const property=properties.find(p=>p.id===String(fd.get("property_id")||""));
  const owner=ownerById(String(fd.get("advisor_owner_id")||""));
  const msg=form.querySelector("#advisorServiceReceiptMessage");

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
    include_in_financials:fd.get("include_in_financials")==="true",
    updated_at:new Date().toISOString()
  };

  if(!row.owner_name || !row.owner_phone || !row.service_description){
    if(msg) msg.textContent="Informe proprietário, telefone e a descrição do serviço.";
    return;
  }
  if(totalServiceReceipt(row)<=0){
    if(msg) msg.textContent="Informe pelo menos um valor maior que zero.";
    return;
  }
  if(row.paid && !row.payment_date){
    if(msg) msg.textContent="Informe a data do pagamento.";
    return;
  }
  if(row.paid && !row.payment_method){
    if(msg) msg.textContent="Informe a forma de pagamento para um recibo de valor recebido.";
    return;
  }

  const result=id
    ? await db.from("advisor_service_receipts").update(row).eq("id",id).eq("advisor_id",currentUser.id).select("*").single()
    : await db.from("advisor_service_receipts").insert(row).select("*").single();

  if(result.error){
    if(msg) msg.textContent=result.error.message;
    return;
  }

  await loadData();
  closeAdvisorModal();
  renderServiceReceipts();
  renderFinance();
  renderManagementDashboard();

  const saved=serviceReceipts.find(r=>r.id===result.data?.id) || result.data;
  if(saved) generateServiceReceiptPdf(saved);
}


function renderRentalControl(){
  const root=$("#advisorRentalControlList");
  if(!root) return;

  const active=rentalControls.filter(r=>r.status==="active");
  const withAdvisory=rentalControls.filter(r=>r.had_advisory_fee && Number(r.advisory_fee_amount||0)>0).length;

  const rows=rentalControls.map(r=>`
    <tr>
      <td>
        <strong>${escapeHTML(r.property_code||"—")}</strong><br>
        <span class="muted">${escapeHTML(r.property_title||"Imóvel")}</span>
        ${r.property_address? `<br><small>${escapeHTML(r.property_address)}</small>` : ""}
      </td>
      <td><strong>${escapeHTML(r.owner_name||"—")}</strong><br><span class="muted">${escapeHTML(r.owner_phone||"")}</span></td>
      <td><strong>${escapeHTML(r.tenant_name||"—")}</strong><br><span class="muted">${escapeHTML(r.tenant_phone||"")}</span></td>
      <td>
        ${r.monthly_rent!=null?money(r.monthly_rent,r.currency):"—"}<br>
        <small>${paymentStatusText(r.rent_paid,r.rent_payment_date)}</small>
      </td>
      <td>
        ${(r.guarantee_type||"deposit")==="guarantor"
          ? '<strong>Fiador</strong><br><small>Sem caução</small>'
          : `<strong>Caução</strong><br><small>${Number(r.security_deposit_count||1)}x de ${money(r.security_deposit||0,r.currency)} • Total ${money(Number(r.security_deposit||0)*Number(r.security_deposit_count||1),r.currency)}</small><br><small>${paymentStatusText(r.security_deposit_paid,r.security_deposit_payment_date)}</small>`}
      </td>
      <td>
        ${r.advisor_commission_charged && r.commission_amount!=null
          ? `${money(r.commission_amount,r.currency)}<br><small>${paymentStatusText(r.commission_paid,r.advisor_commission_payment_date)}</small>`
          : '<span class="muted">Não cobrada</span>'}
      </td>
      <td>
        ${r.had_advisory_fee && r.advisory_fee_amount!=null
          ? `${money(r.advisory_fee_amount,r.currency)}<br><small>${paymentStatusText(r.advisory_fee_paid,r.advisory_fee_payment_date)}</small>`
          : '<span class="muted">Não aplicada</span>'}
      </td>
      <td>${dateOnlyBR(r.start_date)}<br><small>Venc.: dia ${r.rent_due_day||"—"}</small></td>
      <td>
        <div class="table-actions">
          <button class="btn primary compact" type="button" data-generate-rental-pdf="${r.id}">Gerar PDF</button>
          <button class="btn ghost compact" type="button" data-edit-rental-control="${r.id}">Editar</button>
          <button class="btn danger compact" type="button" data-delete-rental-control="${r.id}">Excluir</button>
        </div>
      </td>
    </tr>
  `).join("");

  root.innerHTML=`
    <div class="advisor-rental-summary">
      <div><span>Recibos salvos</span><strong>${rentalControls.length}</strong></div>
      <div><span>Locações ativas</span><strong>${active.length}</strong></div>
      <div><span>Com assessoria</span><strong>${withAdvisory}</strong></div>
    </div>
    <p class="tiny-note">O recibo mostra somente valores cobrados do cliente. Não exibe comissão recebida do proprietário. É apenas um recibo de controle do assessor, sem caráter jurídico, e não substitui contrato de locação ou outro instrumento jurídico.</p>
    ${rows?`
      <div class="admin-table-wrap advisor-rental-table-wrap">
        <table class="admin-table advisor-rental-table">
          <thead><tr><th>Imóvel</th><th>Proprietário</th><th>Inquilino</th><th>Aluguel</th><th>Garantia</th><th>Comissão assessor</th><th>Assessoria</th><th>Data do aluguel</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `:'<div class="empty-state"><strong>Nenhum recibo registrado.</strong><span>Ao marcar um imóvel como alugado, o recibo obrigatório aparecerá aqui.</span></div>'}
  `;
}

function wireReceiptPaymentFields(form){
  if(!form) return;

  const linkPaidDate=(paidName,dateName)=>{
    const paid=form.querySelector(`[name="${paidName}"]`);
    const date=form.querySelector(`[name="${dateName}"]`);
    const wrap=date?.closest(".receipt-payment-date");

    const update=()=>{
      const isPaid=paid?.value==="true";
      wrap?.classList.toggle("hidden",!isPaid);
      if(date){
        date.required=!!isPaid;
        if(!isPaid) date.value="";
      }
    };

    paid?.addEventListener("change",update);
    update();
  };

  linkPaidDate("rent_paid","rent_payment_date");
  linkPaidDate("security_deposit_paid","security_deposit_payment_date");
  linkPaidDate("commission_paid","advisor_commission_payment_date");
  linkPaidDate("advisory_fee_paid","advisory_fee_payment_date");

  const charged=form.querySelector('[name="advisor_commission_charged"]');
  const commissionFields=form.querySelector("#advisorCommissionFields");
  const commissionAmount=form.querySelector('[name="commission_amount"]');
  const commissionPaid=form.querySelector('[name="commission_paid"]');

  const updateCommission=()=>{
    const isCharged=charged?.value==="true";
    commissionFields?.classList.toggle("hidden",!isCharged);
    if(commissionAmount) commissionAmount.required=!!isCharged;
    if(!isCharged){
      if(commissionAmount) commissionAmount.value="";
      if(commissionPaid) commissionPaid.value="false";
      const paymentDate=form.querySelector('[name="advisor_commission_payment_date"]');
      if(paymentDate) paymentDate.value="";
    }
  };

  charged?.addEventListener("change",updateCommission);
  updateCommission();
}

function wireManualReceiptFields(form){
  if(!form) return;

  const propertySelect=form.querySelector('[name="property_id"]');
  const ownerSelect=form.querySelector('[name="advisor_owner_id"]');
  const ownerName=form.querySelector('[name="owner_name"]');
  const ownerPhone=form.querySelector('[name="owner_phone"]');

  const fillOwner=(owner)=>{
    if(!owner) return;
    if(ownerName) ownerName.value=owner.full_name||"";
    if(ownerPhone) ownerPhone.value=owner.whatsapp||"";
  };

  ownerSelect?.addEventListener("change",()=>fillOwner(ownerById(ownerSelect.value)));
  propertySelect?.addEventListener("change",()=>{
    const property=properties.find(p=>p.id===propertySelect.value);
    if(!property) return;
    if(ownerSelect && property.advisor_owner_id){
      ownerSelect.value=property.advisor_owner_id;
      fillOwner(ownerById(property.advisor_owner_id));
    }
  });

  const mode=form.querySelector('[name="closing_mode"]');
  const wrapper=form.querySelector("#manualAdvisoryFields");
  const guarantee=form.querySelector('[name="guarantee_type"]');
  const depositWrapper=form.querySelector("#manualDepositFields");
  const hasContract=form.querySelector('[name="has_contract"]');
  const contractWrapper=form.querySelector("#manualContractFields");

  const update=()=>{
    const direct=mode?.value==="direct_owner";
    wrapper?.classList.toggle("hidden",direct);
    const fee=form.querySelector('[name="advisory_fee_amount"]');
    const paid=form.querySelector('[name="advisory_fee_paid"]');
    const paymentDate=form.querySelector('[name="advisory_fee_payment_date"]');
    if(fee) fee.required=!direct;
    if(direct){
      if(fee) fee.value="";
      if(paid) paid.value="false";
      if(paymentDate) paymentDate.value="";
    }

    const usesDeposit=(guarantee?.value||"deposit")==="deposit";
    depositWrapper?.classList.toggle("hidden",!usesDeposit);
    const depositAmount=form.querySelector('[name="security_deposit"]');
    const depositCount=form.querySelector('[name="security_deposit_count"]');
    const depositPaid=form.querySelector('[name="security_deposit_paid"]');
    const depositDate=form.querySelector('[name="security_deposit_payment_date"]');
    if(depositAmount) depositAmount.required=usesDeposit;
    if(depositCount) depositCount.required=usesDeposit;
    if(!usesDeposit){
      if(depositAmount) depositAmount.value="";
      if(depositCount) depositCount.value="";
      if(depositPaid) depositPaid.value="false";
      if(depositDate) depositDate.value="";
    }

    const contractEnabled=hasContract?.value==="true";
    contractWrapper?.classList.toggle("hidden",!contractEnabled);
    const contractAmount=form.querySelector('[name="contract_amount"]');
    const contractPayer=form.querySelector('[name="contract_payer"]');
    if(contractAmount) contractAmount.required=contractEnabled;
    if(contractPayer) contractPayer.required=contractEnabled;
    if(!contractEnabled){
      if(contractAmount) contractAmount.value="";
      if(contractPayer) contractPayer.value="";
    }
  };

  mode?.addEventListener("change",update);
  guarantee?.addEventListener("change",update);
  hasContract?.addEventListener("change",update);
  update();
  wireReceiptPaymentFields(form);
}

function rentalControlModal(row=null){
  const propertyOptions=properties.map(p=>`
    <option value="${p.id}" ${row?.property_id===p.id?"selected":""}>${escapeHTML(p.public_code||"—")} • ${escapeHTML(p.title)}</option>
  `).join("");

  const direct=(row?.closing_mode||"advisor")==="direct_owner";

  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">RECIBO DE LOCAÇÃO</p>
        <h2>${row?"Editar":"Registrar"} recibo</h2>
        <p class="muted">O recibo mostra somente valores cobrados do cliente. A comissão abaixo é a comissão cobrada pelo assessor. Não contém comissão recebida do proprietário. O documento é apenas para controle do assessor, sem caráter jurídico.</p>
      </div>
      <button class="icon-btn" type="button" data-close>✕</button>
    </div>

    <form id="advisorRentalControlForm" class="form-grid rental-receipt-form">
      <input type="hidden" name="id" value="${row?.id||""}">

      <label class="span-2">Imóvel vinculado
        <select name="property_id">
          <option value="">Recibo sem anúncio vinculado</option>
          ${propertyOptions}
        </select>
      </label>

      <label class="span-2">Proprietário cadastrado
        <select name="advisor_owner_id">
          ${ownerOptions(row?.advisor_owner_id||properties.find(p=>p.id===row?.property_id)?.advisor_owner_id||"",true)}
        </select>
      </label>

      <label class="span-2">Identificação do imóvel
        <input name="property_title" value="${escapeHTML(row?.property_title||"")}" placeholder="Ex.: Apartamento 2 quartos">
      </label>

      <label class="span-2">Endereço do imóvel
        <input name="property_address" value="${escapeHTML(row?.property_address||"")}" placeholder="Rua, número, bairro e cidade">
      </label>

      <div class="form-section-title property-section-title">Partes</div>
      <label>Nome do proprietário<input name="owner_name" required value="${escapeHTML(row?.owner_name||"")}"></label>
      <label>Nome do inquilino<input name="tenant_name" required value="${escapeHTML(row?.tenant_name||"")}"></label>

      <div class="form-section-title property-section-title">Aluguel e pagamentos</div>
      <label>Moeda
        <select name="currency">
          <option value="BRL" ${(row?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${row?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>
      <label>Valor do aluguel<input name="monthly_rent" type="number" min="0" step="1" required value="${row?.monthly_rent??""}"></label>

      <label>Aluguel pago?
        <select name="rent_paid">
          <option value="false" ${!row?.rent_paid?"selected":""}>Não</option>
          <option value="true" ${row?.rent_paid?"selected":""}>Sim</option>
        </select>
      </label>
      <label class="receipt-payment-date ${row?.rent_paid?"":"hidden"}">Data do pagamento do aluguel
        <input name="rent_payment_date" type="date" value="${row?.rent_payment_date||""}">
      </label>

      <label>Garantia
        <select name="guarantee_type">
          <option value="deposit" ${(row?.guarantee_type||"deposit")==="deposit"?"selected":""}>Caução</option>
          <option value="guarantor" ${row?.guarantee_type==="guarantor"?"selected":""}>Fiador</option>
        </select>
      </label>
      <label>Tempo mínimo
        <select name="minimum_contract_term">
          <option value="none" ${(row?.minimum_contract_term||"none")==="none"?"selected":""}>Sem tempo mínimo</option>
          <option value="6_months" ${row?.minimum_contract_term==="6_months"?"selected":""}>6 meses</option>
          <option value="12_months" ${row?.minimum_contract_term==="12_months"?"selected":""}>1 ano</option>
        </select>
      </label>

      <div id="manualDepositFields" class="span-2 conditional-subgrid ${row?.guarantee_type==="guarantor"?"hidden":""}">
        <label>Quantidade de cauções
          <input name="security_deposit_count" type="number" min="1" max="24" step="1" value="${row?.security_deposit_count??(row?.security_deposit!=null?1:"")}">
        </label>
        <label>Valor de cada caução
          <input name="security_deposit" type="number" min="0" step="1" value="${row?.security_deposit??""}">
        </label>
        <label>Caução paga?
          <select name="security_deposit_paid"><option value="false" ${!row?.security_deposit_paid?"selected":""}>Não</option><option value="true" ${row?.security_deposit_paid?"selected":""}>Sim</option></select>
        </label>
        <label class="receipt-payment-date ${row?.security_deposit_paid?"":"hidden"}">Data do pagamento da caução
          <input name="security_deposit_payment_date" type="date" value="${row?.security_deposit_payment_date||""}">
        </label>
      </div>

      <label>Possui contrato?
        <select name="has_contract">
          <option value="false" ${!row?.has_contract?"selected":""}>Não</option>
          <option value="true" ${row?.has_contract?"selected":""}>Sim</option>
        </select>
      </label>
      <div></div>

      <div id="manualContractFields" class="span-2 conditional-subgrid ${row?.has_contract?"":"hidden"}">
        <label>Valor do contrato
          <input name="contract_amount" type="number" min="0" step="1" value="${row?.contract_amount??""}">
        </label>
        <label>Quem paga o contrato?
          <select name="contract_payer">
            <option value="">Selecione</option>
            <option value="owner" ${row?.contract_payer==="owner"?"selected":""}>Proprietário</option>
            <option value="tenant" ${row?.contract_payer==="tenant"?"selected":""}>Inquilino</option>
          </select>
        </label>
      </div>

      <div class="form-section-title property-section-title">Comissão do assessor</div>
      <label>Foi cobrada comissão pelo assessor?
        <select name="advisor_commission_charged">
          <option value="false" ${!row?.advisor_commission_charged?"selected":""}>Não</option>
          <option value="true" ${row?.advisor_commission_charged?"selected":""}>Sim</option>
        </select>
      </label>
      <div></div>

      <div id="advisorCommissionFields" class="span-2 conditional-subgrid ${row?.advisor_commission_charged?"":"hidden"}">
        <label>Valor da comissão do assessor
          <input name="commission_amount" type="number" min="0" step="1" value="${row?.advisor_commission_charged?(row?.commission_amount??""):""}">
        </label>
        <label>Comissão paga?
          <select name="commission_paid">
            <option value="false" ${!row?.commission_paid?"selected":""}>Não</option>
            <option value="true" ${row?.commission_paid?"selected":""}>Sim</option>
          </select>
        </label>
        <label class="receipt-payment-date ${row?.commission_paid?"":"hidden"}">Data do pagamento da comissão
          <input name="advisor_commission_payment_date" type="date" value="${row?.advisor_commission_payment_date||""}">
        </label>
      </div>

      <div class="form-section-title property-section-title">Assessoria</div>
      <label>Forma de fechamento
        <select name="closing_mode">
          <option value="advisor" ${!direct?"selected":""}>Via assessoria</option>
          <option value="direct_owner" ${direct?"selected":""}>Direto com o proprietário</option>
        </select>
      </label>
      <div></div>

      <div id="manualAdvisoryFields" class="span-2 conditional-subgrid ${direct?"hidden":""}">
        <label>Valor da assessoria
          <input name="advisory_fee_amount" type="number" min="0" step="1" value="${row?.had_advisory_fee?(row?.advisory_fee_amount??""):""}">
        </label>
        <label>Assessoria paga?
          <select name="advisory_fee_paid">
            <option value="false" ${!row?.advisory_fee_paid?"selected":""}>Não</option>
            <option value="true" ${row?.advisory_fee_paid?"selected":""}>Sim</option>
          </select>
        </label>
        <label class="receipt-payment-date ${row?.advisory_fee_paid?"":"hidden"}">Data do pagamento da assessoria
          <input name="advisory_fee_payment_date" type="date" value="${row?.advisory_fee_payment_date||""}">
        </label>
      </div>

      <div class="form-section-title property-section-title">Datas</div>
      <label>Data do aluguel<input name="start_date" type="date" required value="${row?.start_date||""}"></label>
      <label>Fim / término<input name="end_date" type="date" value="${row?.end_date||""}"></label>
      <label>Dia de vencimento do aluguel<input name="rent_due_day" type="number" min="1" max="31" value="${row?.rent_due_day??""}"></label>
      <label>Status
        <select name="status"><option value="active" ${row?.status!=="ended"?"selected":""}>Ativa</option><option value="ended" ${row?.status==="ended"?"selected":""}>Encerrada</option></select>
      </label>

      <div id="advisorRentalControlMessage" class="form-message span-2"></div>
      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar recibo</button>
      </div>
    </form>
  `);

  wireManualReceiptFields($("#advisorRentalControlForm"));
}

async function saveRentalControl(form){
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const propertyId=String(fd.get("property_id")||"").trim()||null;
  const property=propertyId?properties.find(p=>p.id===propertyId):null;
  const existing=id?rentalControls.find(r=>r.id===id):null;
  const msg=form.querySelector("#advisorRentalControlMessage");
  const n=v=>String(v??"").trim()===""?null:Number(v);
  const closingMode=String(fd.get("closing_mode")||"advisor");
  const hadAdvisory=closingMode!=="direct_owner" && n(fd.get("advisory_fee_amount"))!=null;
  const guaranteeType=fd.get("guarantee_type")||"deposit";
  const usesDeposit=guaranteeType==="deposit";
  const hasContract=fd.get("has_contract")==="true";
  const commissionCharged=fd.get("advisor_commission_charged")==="true";
  const rentPaid=fd.get("rent_paid")==="true";
  const depositPaid=usesDeposit && fd.get("security_deposit_paid")==="true";
  const commissionPaid=commissionCharged && fd.get("commission_paid")==="true";
  const advisoryPaid=hadAdvisory && fd.get("advisory_fee_paid")==="true";

  const row={
    advisor_id:currentUser.id,
    property_id:propertyId,
    property_code:property?.public_code||existing?.property_code||null,
    property_title:property?.title||String(fd.get("property_title")||"").trim()||existing?.property_title||null,
    property_address:property?.address||String(fd.get("property_address")||"").trim()||existing?.property_address||null,
    property_neighborhood:property?.neighborhood||existing?.property_neighborhood||null,
    property_city:property?.city||existing?.property_city||null,
    closing_mode:closingMode,
    had_advisory_fee:hadAdvisory,
    owner_name:String(fd.get("owner_name")||"").trim()||null,
    owner_phone:String(fd.get("owner_phone")||"").trim()||null,
    tenant_name:String(fd.get("tenant_name")||"").trim(),
    tenant_phone:String(fd.get("tenant_phone")||"").trim()||null,
    currency:fd.get("currency")||"BRL",
    monthly_rent:n(fd.get("monthly_rent")),
    rent_paid:rentPaid,
    rent_payment_date:rentPaid?(fd.get("rent_payment_date")||null):null,
    guarantee_type:guaranteeType,
    security_deposit_count:usesDeposit?n(fd.get("security_deposit_count")):null,
    security_deposit:usesDeposit?n(fd.get("security_deposit")):null,
    security_deposit_paid:depositPaid,
    security_deposit_payment_date:depositPaid?(fd.get("security_deposit_payment_date")||null):null,
    minimum_contract_term:fd.get("minimum_contract_term")||"none",
    has_contract:hasContract,
    contract_amount:hasContract?n(fd.get("contract_amount")):null,
    contract_payer:hasContract?(fd.get("contract_payer")||null):null,
    advisor_commission_charged:commissionCharged,
    commission_amount:commissionCharged?n(fd.get("commission_amount")):null,
    commission_paid:commissionPaid,
    advisor_commission_payment_date:commissionPaid?(fd.get("advisor_commission_payment_date")||null):null,
    advisory_fee_amount:hadAdvisory?n(fd.get("advisory_fee_amount")):null,
    advisory_fee_paid:advisoryPaid,
    advisory_fee_payment_date:advisoryPaid?(fd.get("advisory_fee_payment_date")||null):null,
    start_date:fd.get("start_date")||null,
    end_date:fd.get("end_date")||null,
    rent_due_day:n(fd.get("rent_due_day")),
    status:fd.get("status")||"active",
    notes:String(fd.get("notes")||"").trim()||null
  };

  if(!row.owner_name || !row.tenant_name || !row.start_date){
    if(msg) msg.textContent="Informe proprietário, inquilino e a data do aluguel.";
    return;
  }
  if(commissionCharged && !(Number(row.commission_amount)>0)){
    if(msg) msg.textContent="Informe o valor da comissão cobrada pelo assessor.";
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

function rentalReceiptModal(property){
  if(!property) return;
  const linkedOwner=ownerById(property.advisor_owner_id);
  const showAdvisory=property.closing_mode!=="direct_owner" && property.has_advisory_fee;
  const usesDeposit=(property.guarantee_type||"deposit")==="deposit";
  const depositCount=Number(property.security_deposit_count||1);
  const depositTotal=usesDeposit && property.security_deposit!=null
    ? Number(property.security_deposit)*depositCount
    : null;

  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">FINALIZAR LOCAÇÃO</p>
        <h2>Preencher recibo obrigatório</h2>
        <p class="muted">A comissão abaixo é somente a comissão cobrada pelo assessor do cliente. Não é comissão recebida do proprietário. Este documento é apenas para controle do assessor, sem caráter jurídico.</p>
      </div>
      <button class="icon-btn" type="button" data-close>✕</button>
    </div>

    <form id="advisorRentalReceiptForm" class="form-grid rental-receipt-form">
      <input type="hidden" name="property_id" value="${property.id}">

      <div class="span-2 published-property-lock-banner">
        <strong>${escapeHTML(property.public_code||"IMÓVEL")} • ${escapeHTML(property.title)}</strong>
        <span>${escapeHTML([property.address,property.neighborhood,property.city].filter(Boolean).join(" • ")||"Localização não informada")}</span>
      </div>

      <div class="span-2 receipt-property-condition">
        <strong>Condições cadastradas do imóvel</strong>
        <span>Tempo mínimo: ${property.minimum_contract_term==="6_months"?"6 meses":property.minimum_contract_term==="12_months"?"1 ano":"sem tempo mínimo"} • ${property.has_contract?`Contrato: ${money(property.contract_amount||0,property.currency||"BRL")} pago pelo ${property.contract_payer==="owner"?"proprietário":"inquilino"}`:"Sem cobrança de contrato"}</span>
      </div>

      <label>Nome do proprietário
        <input name="owner_name" required autocomplete="name" value="${escapeHTML(linkedOwner?.full_name||"")}">
      </label>
      <label>Nome do inquilino
        <input name="tenant_name" required autocomplete="name">
      </label>

      <div class="form-section-title property-section-title">Aluguel e pagamentos</div>
      <label>Moeda
        <select name="currency" required>
          <option value="BRL" ${property.currency!=="PYG"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${property.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>
      <label>Valor do aluguel
        <input name="monthly_rent" type="number" min="0" step="1" required value="${property.price??0}">
      </label>

      <label>Aluguel pago?
        <select name="rent_paid">
          <option value="false">Não</option>
          <option value="true">Sim</option>
        </select>
      </label>
      <label class="receipt-payment-date hidden">Data do pagamento do aluguel
        <input name="rent_payment_date" type="date">
      </label>

${usesDeposit?`
      <div class="span-2 receipt-property-condition">
        <strong>Garantia: Caução</strong>
        <span>${depositCount} caução${depositCount===1?"":"ões"} de ${money(property.security_deposit||0,property.currency||"BRL")} • Total: ${money(depositTotal||0,property.currency||"BRL")}</span>
      </div>
      <label>Valor de cada caução
        <input name="security_deposit" type="number" min="0" step="1" required value="${property.security_deposit??0}">
      </label>
      <label>Caução paga?
        <select name="security_deposit_paid">
          <option value="false">Não</option>
          <option value="true">Sim</option>
        </select>
      </label>
      <label class="receipt-payment-date hidden">Data do pagamento da caução
        <input name="security_deposit_payment_date" type="date">
      </label>
      <div></div>
      `:`
      <div class="span-2 receipt-property-condition">
        <strong>Garantia: Fiador</strong>
        <span>Este imóvel não exige caução.</span>
      </div>
      `}

      <div class="form-section-title property-section-title">Comissão do assessor</div>
      <label>Foi cobrada comissão pelo assessor?
        <select name="advisor_commission_charged">
          <option value="false">Não</option>
          <option value="true">Sim</option>
        </select>
      </label>
      <div></div>

      <div id="advisorCommissionFields" class="span-2 conditional-subgrid hidden">
        <label>Valor da comissão do assessor
          <input name="commission_amount" type="number" min="0" step="1">
        </label>
        <label>Comissão paga?
          <select name="commission_paid">
            <option value="false">Não</option>
            <option value="true">Sim</option>
          </select>
        </label>
        <label class="receipt-payment-date hidden">Data do pagamento da comissão
          <input name="advisor_commission_payment_date" type="date">
        </label>
      </div>

      ${showAdvisory?`
        <div class="form-section-title property-section-title">Assessoria</div>
        <label>Valor da assessoria
          <input name="advisory_fee_amount" type="number" min="0" step="1" required value="${property.advisory_fee??0}">
        </label>
        <label>Assessoria paga?
          <select name="advisory_fee_paid">
            <option value="false">Não</option>
            <option value="true">Sim</option>
          </select>
        </label>
        <label class="receipt-payment-date hidden">Data do pagamento da assessoria
          <input name="advisory_fee_payment_date" type="date">
        </label>
        <div></div>
      `:""}

      <div class="form-section-title property-section-title">Datas</div>
      <label>Data do aluguel
        <input name="start_date" type="date" required>
      </label>
      <label>Dia de vencimento do aluguel
        <input name="rent_due_day" type="number" min="1" max="31" step="1">
      </label>

      <div id="advisorRentalReceiptMessage" class="form-message span-2"></div>

      <div class="form-actions span-2">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn danger" type="submit">Confirmar aluguel e excluir anúncio</button>
      </div>
    </form>
  `);

  wireReceiptPaymentFields($("#advisorRentalReceiptForm"));
}

async function markPropertyRented(form){
  if(!form?.reportValidity()) return;

  const fd=new FormData(form);
  const propertyId=String(fd.get("property_id")||"");
  const property=properties.find(p=>p.id===propertyId);
  const msg=form.querySelector("#advisorRentalReceiptMessage");
  const submit=form.querySelector('button[type="submit"]');

  if(!property){
    if(msg) msg.textContent="Este imóvel não está mais disponível na sua lista.";
    return;
  }

  const showAdvisory=property.closing_mode!=="direct_owner" && property.has_advisory_fee;
  const usesDeposit=(property.guarantee_type||"deposit")==="deposit";
  const commissionCharged=fd.get("advisor_commission_charged")==="true";
  const rentPaid=fd.get("rent_paid")==="true";
  const depositPaid=usesDeposit && fd.get("security_deposit_paid")==="true";
  const commissionPaid=commissionCharged && fd.get("commission_paid")==="true";
  const advisoryPaid=showAdvisory && fd.get("advisory_fee_paid")==="true";

  const receipt={
    owner_name:String(fd.get("owner_name")||"").trim(),
    owner_phone:String(fd.get("owner_phone")||"").trim()||null,
    tenant_name:String(fd.get("tenant_name")||"").trim(),
    tenant_phone:String(fd.get("tenant_phone")||"").trim()||null,
    currency:fd.get("currency")||property.currency||"BRL",
    monthly_rent:Number(fd.get("monthly_rent")||0),
    rent_paid:rentPaid,
    rent_payment_date:rentPaid?(fd.get("rent_payment_date")||null):null,
    security_deposit:usesDeposit?Number(fd.get("security_deposit")||property.security_deposit||0):null,
    security_deposit_paid:depositPaid,
    security_deposit_payment_date:depositPaid?(fd.get("security_deposit_payment_date")||null):null,
    advisor_commission_charged:commissionCharged,
    commission_amount:commissionCharged?Number(fd.get("commission_amount")||0):null,
    commission_paid:commissionPaid,
    advisor_commission_payment_date:commissionPaid?(fd.get("advisor_commission_payment_date")||null):null,
    advisory_fee_amount:showAdvisory?Number(fd.get("advisory_fee_amount")||0):null,
    advisory_fee_paid:advisoryPaid,
    advisory_fee_payment_date:advisoryPaid?(fd.get("advisory_fee_payment_date")||null):null,
    start_date:fd.get("start_date"),
    rent_due_day:fd.get("rent_due_day")?Number(fd.get("rent_due_day")):null,
    notes:String(fd.get("notes")||"").trim()||null
  };

  if(commissionCharged && !(Number(receipt.commission_amount)>0)){
    if(msg) msg.textContent="Informe o valor da comissão cobrada pelo assessor.";
    return;
  }

  if(submit){
    submit.disabled=true;
    submit.textContent="Finalizando...";
  }
  if(msg) msg.textContent="Salvando recibo e removendo o anúncio...";

  const result=await db.rpc("finalize_property_rental",{
    p_property_id:property.id,
    p_receipt:receipt
  });

  if(result.error){
    if(msg) msg.textContent=result.error.message;
    if(submit){submit.disabled=false;submit.textContent="Confirmar aluguel e excluir anúncio";}
    return;
  }

  if(result.data?.receipt_id && property.advisor_owner_id){
    const ownerLink=await db.from("advisor_rental_control")
      .update({advisor_owner_id:property.advisor_owner_id})
      .eq("id",result.data.receipt_id)
      .eq("advisor_id",currentUser.id);
    if(ownerLink.error) console.warn("Locação salva, mas o proprietário não foi vinculado ao histórico:",ownerLink.error);
  }

  const paths=Array.isArray(result.data?.storage_paths)?result.data.storage_paths:[];
  let cleanupWarning="";
  if(paths.length){
    const cleanup=await db.storage.from(STORAGE_BUCKET).remove(paths);
    if(cleanup.error){
      console.warn("Anúncio removido, mas houve falha ao limpar algumas imagens:",cleanup.error);
      cleanupWarning=" O anúncio foi removido, mas algumas imagens podem precisar de limpeza administrativa no armazenamento.";
    }
  }

  await loadData();
  closeAdvisorModal();
  renderPanel();
  alert("Imóvel marcado como alugado. O anúncio foi excluído e o recibo do cliente foi preservado."+cleanupWarning);
}

function receiptAddressText(row){
  return [row.property_address,row.property_neighborhood,row.property_city].filter(Boolean).join(" • ");
}

function safePdfText(value){
  return String(value??"").replace(/[\r\n]+/g," ").trim();
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

  const addSection=(title)=>{
    y+=3;
    doc.setFont("helvetica","bold");
    doc.setFontSize(11.5);
    doc.setTextColor(19,35,59);
    doc.text(title,left,y);
    doc.setTextColor(0);
    y+=7;
  };

  const addLine=(label,value)=>{
    if(value===null || value===undefined || value==="") return;
    if(y>260){
      doc.addPage();
      y=20;
    }
    doc.setFont("helvetica","bold");
    doc.setFontSize(9.5);
    doc.text(label,left,y);
    doc.setFont("helvetica","normal");
    const text=doc.splitTextToSize(safePdfText(value),width-48);
    doc.text(text,left+48,y);
    y+=Math.max(6,text.length*4.7);
  };

  doc.setFillColor(19,35,59);
  doc.roundedRect(left,y,width,25,3,3,"F");
  doc.setTextColor(255);
  doc.setFont("helvetica","bold");
  doc.setFontSize(17);
  doc.text("RECIBO DE ASSESSORIA IMOBILIÁRIA",left+5,y+9);
  doc.setFontSize(9);
  doc.setFont("helvetica","normal");
  doc.text(`${safePdfText(row.receipt_code||"RECIBO")} • Emitido em ${new Intl.DateTimeFormat("pt-BR").format(new Date())}`,left+5,y+17);
  doc.setTextColor(0);
  y+=34;

  addSection("Assessor / emitente");
  addLine("Nome:",profile?.full_name||profile?.company_name||"Assessor");
  addLine("Assessoria:",profile?.company_name);
  addLine("Telefone / WhatsApp:",profile?.whatsapp||profile?.phone);

  addSection("Imóvel");
  addLine("Código:",row.property_code||"Sem anúncio vinculado");
  addLine("Imóvel:",row.property_title);
  addLine("Endereço:",row.property_address);

  addSection("Proprietário");
  addLine("Nome:",row.owner_name);
  addLine("Telefone:",row.owner_phone);

  if(row.client_name || row.client_phone){
    addSection("Cliente / inquilino");
    addLine("Nome:",row.client_name);
    addLine("Telefone:",row.client_phone);
  }

  addSection("Serviço");
  addLine("Descrição:",row.service_description);

  addSection("Valores");
  if(Number(row.commission_amount||0)>0) addLine("Comissão:",money(row.commission_amount,row.currency));
  if(Number(row.advisory_fee_amount||0)>0) addLine("Taxa de assessoria:",money(row.advisory_fee_amount,row.currency));
  if(Number(row.contract_amount||0)>0) addLine("Contrato / documentação:",money(row.contract_amount,row.currency));
  if(Number(row.other_amount||0)>0) addLine("Outros valores:",money(row.other_amount,row.currency));
  addLine("TOTAL:",money(totalServiceReceipt(row),row.currency));

  addSection("Pagamento");
  addLine("Situação:",row.paid?"Valor recebido":"Pagamento pendente");
  addLine("Data:",row.payment_date?dateOnlyBR(row.payment_date):"—");
  addLine("Forma:",row.payment_method);
  addLine("Referência:",row.payment_reference);

  if(row.notes){
    addSection("Observações");
    const notes=doc.splitTextToSize(safePdfText(row.notes),width);
    doc.setFont("helvetica","normal");
    doc.setFontSize(9);
    doc.text(notes,left,y);
    y+=notes.length*4.5+4;
  }

  if(y>220){
    doc.addPage();
    y=25;
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
    ? `Declaro, para fins de registro, o recebimento do valor total de ${money(totalServiceReceipt(row),row.currency)}, referente ao serviço descrito neste documento.`
    : `Este documento registra os valores e serviços informados, permanecendo o pagamento indicado como pendente.`;
  const decLines=doc.splitTextToSize(declaration,width-8);
  doc.text(decLines,left+4,y+12);
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
  const discLines=doc.splitTextToSize(disclaimer,width);
  doc.text(discLines,left,282-(discLines.length*3.5));

  const code=safePdfText(row.receipt_code||"recibo").replace(/[^A-Za-z0-9_-]+/g,"-");
  doc.save(`${code}.pdf`);
}


function generateRentalReceiptPdf(row){
  const JsPDF=window.jspdf?.jsPDF;
  if(!JsPDF){
    alert("O gerador de PDF ainda não carregou. Atualize a página e tente novamente.");
    return;
  }

  const doc=new JsPDF({unit:"mm",format:"a4"});
  const left=18;
  const right=192;
  const width=right-left;
  let y=20;

  const addLine=(label,value)=>{
    if(value===null || value===undefined || value==="") return;
    doc.setFont("helvetica","bold");
    doc.setFontSize(10);
    doc.text(label,left,y);
    doc.setFont("helvetica","normal");
    const text=doc.splitTextToSize(safePdfText(value),width-45);
    doc.text(text,left+45,y);
    y+=Math.max(7,text.length*5);
  };

  doc.setFont("helvetica","bold");
  doc.setFontSize(18);
  doc.text("RECIBO DE LOCAÇÃO",left,y);
  y+=8;

  doc.setFont("helvetica","normal");
  doc.setFontSize(9);
  doc.text(`Recibo ${safePdfText(row.property_code||String(row.id).slice(0,8).toUpperCase())}`,left,y);
  doc.text(`Emitido em ${new Intl.DateTimeFormat("pt-BR").format(new Date())}`,right,y,{align:"right"});
  y+=6;

  doc.setDrawColor(180);
  doc.line(left,y,right,y);
  y+=9;

  doc.setFont("helvetica","bold");
  doc.setFontSize(12);
  doc.text("Imóvel",left,y);
  y+=7;
  addLine("Identificação:",row.property_title||row.property_code||"Imóvel");
  addLine("Código:",row.property_code);
  addLine("Endereço:",receiptAddressText(row));

  y+=3;
  doc.setFont("helvetica","bold");
  doc.setFontSize(12);
  doc.text("Partes",left,y);
  y+=7;
  addLine("Proprietário:",row.owner_name);
  addLine("Inquilino:",row.tenant_name);

  y+=3;
  doc.setFont("helvetica","bold");
  doc.setFontSize(12);
  doc.text("Valores e período",left,y);
  y+=7;
  addLine("Aluguel:",row.monthly_rent!=null?money(row.monthly_rent,row.currency):"—");
  addLine("Pagamento aluguel:",paymentStatusText(row.rent_paid,row.rent_payment_date));

  const guaranteeType=row.guarantee_type||"deposit";
  if(guaranteeType==="guarantor"){
    addLine("Garantia:","Fiador");
  }else{
    const depositCount=Number(row.security_deposit_count||1);
    const unitAmount=Number(row.security_deposit||0);
    addLine("Garantia:","Caução");
    addLine("Quantidade:",`${depositCount} caução${depositCount===1?"":"ões"}`);
    addLine("Valor por caução:",money(unitAmount,row.currency));
    addLine("Total das cauções:",money(unitAmount*depositCount,row.currency));
    addLine("Pagamento caução:",paymentStatusText(row.security_deposit_paid,row.security_deposit_payment_date));
  }

  const minTerm=row.minimum_contract_term==="6_months"?"6 meses":row.minimum_contract_term==="12_months"?"1 ano":"Sem tempo mínimo";
  addLine("Tempo mínimo:",minTerm);

  if(row.has_contract){
    addLine("Contrato:","Sim");
    addLine("Valor do contrato:",row.contract_amount!=null?money(row.contract_amount,row.currency):"—");
    addLine("Contrato pago por:",row.contract_payer==="owner"?"Proprietário":"Inquilino");
  }else{
    addLine("Contrato:","Não possui");
  }

  if(row.advisor_commission_charged && row.commission_amount!=null){
    addLine("Comissão assessor:",money(row.commission_amount,row.currency));
    addLine("Pagamento comissão:",paymentStatusText(row.commission_paid,row.advisor_commission_payment_date));
  }

  if(row.had_advisory_fee && row.advisory_fee_amount!=null){
    addLine("Assessoria:",money(row.advisory_fee_amount,row.currency));
    addLine("Pagamento assessoria:",paymentStatusText(row.advisory_fee_paid,row.advisory_fee_payment_date));
  }

  addLine("Data do aluguel:",dateOnlyBR(row.start_date));
  if(row.rent_due_day) addLine("Vencimento:",`Dia ${row.rent_due_day} de cada mês`);

  if(row.notes){
    y+=3;
    doc.setFont("helvetica","bold");
    doc.setFontSize(12);
    doc.text("Observações",left,y);
    y+=7;
    doc.setFont("helvetica","normal");
    doc.setFontSize(10);
    const notes=doc.splitTextToSize(safePdfText(row.notes),width);
    doc.text(notes,left,y);
    y+=notes.length*5+4;
  }

  y+=8;
  doc.setFillColor(248,248,248);
  doc.setDrawColor(190);
  doc.roundedRect(left,y,width,22,2,2,"FD");
  doc.setFont("helvetica","bold");
  doc.setFontSize(8.5);
  doc.setTextColor(70);
  doc.text("AVISO",left+4,y+6);
  doc.setFont("helvetica","normal");
  doc.setFontSize(8);
  const disclaimer=doc.splitTextToSize("Este documento é apenas um recibo de controle do assessor, sem caráter jurídico. Não substitui contrato de locação ou qualquer outro instrumento jurídico.",width-8);
  doc.text(disclaimer,left+4,y+11);
  doc.setTextColor(0);
  y+=28;

  y=Math.max(y+8,225);
  doc.setDrawColor(160);
  doc.line(left,y,left+70,y);
  doc.line(right-70,y,right,y);
  y+=5;
  doc.setFontSize(9);
  doc.text("Proprietário / responsável",left+35,y,{align:"center"});
  doc.text("Inquilino",right-35,y,{align:"center"});

  const issuer=profile?.company_name||profile?.full_name||"";
  if(issuer){
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Documento gerado por ${safePdfText(issuer)}`,left,282);
  }

  const code=safePdfText(row.property_code||"locacao").replace(/[^A-Za-z0-9_-]+/g,"-");
  const tenant=safePdfText(row.tenant_name||"cliente").replace(/[^A-Za-z0-9_-]+/g,"-");
  doc.save(`recibo-${code}-${tenant}.pdf`);
}

function advisorCatalogShareUrl(){
  const code=String(profile?.catalog_share_code||"").trim();
  if(!code) return "";
  const url=new URL("index.html",location.href);
  url.search="";
  url.hash="";
  url.searchParams.set("catalogo",code);
  return url.href;
}

function renderAdvisorCatalogShare(){
  const url=advisorCatalogShareUrl();
  const preview=$("#advisorCatalogLinkPreview");
  const open=$("#openAdvisorCatalog");
  if(preview) preview.textContent=url||"Link indisponível";
  if(open){
    open.href=url||"index.html";
    open.classList.toggle("disabled",!url);
  }
}

async function copyAdvisorCatalogLink(button=null){
  const url=advisorCatalogShareUrl();
  if(!url){
    alert("Não foi possível gerar o link do seu catálogo. Atualize a página e tente novamente.");
    return;
  }
  try{
    await navigator.clipboard.writeText(url);
    if(button){
      const original=button.textContent;
      button.textContent="Link copiado ✓";
      setTimeout(()=>{ if(document.body.contains(button)) button.textContent=original; },1800);
    }else{
      alert("Link do catálogo copiado.");
    }
  }catch{
    prompt("Copie o link do seu catálogo:",url);
  }
}

async function shareAdvisorCatalog(){
  const url=advisorCatalogShareUrl();
  if(!url){
    alert("Não foi possível gerar o link do seu catálogo. Atualize a página e tente novamente.");
    return;
  }

  const name=profile?.company_name || profile?.full_name || "meu catálogo de imóveis";
  const shareData={
    title:`Catálogo de ${name}`,
    text:`Veja os imóveis disponíveis no catálogo de ${name}.`,
    url
  };

  if(navigator.share){
    try{
      await navigator.share(shareData);
      return;
    }catch(err){
      if(err?.name==="AbortError") return;
    }
  }

  await copyAdvisorCatalogLink($("#shareAdvisorCatalogMain")||$("#shareAdvisorCatalog"));
}

function renderPanel(){
  $("#advisorWelcome").textContent=profile?.company_name || profile?.full_name || "Meus anúncios";
  renderAdvisorAvatar();
  renderCreditWallet();
  renderExpiredNotice();
  renderPlans();
  renderCreditStore();
  renderAds();
  renderAdvisorCatalogShare();
  renderRentalControl();

  const notificationBadge=$("#advisorNotificationBadge");
  if(notificationBadge){
    notificationBadge.textContent=String(unreadCollaborationNotifications);
    notificationBadge.classList.toggle("hidden",unreadCollaborationNotifications<=0);
  }

  const newBtn=$("#newAdvisorProperty");
  if(newBtn){
    const balance=creditBalance();
    if(balance>0){
      newBtn.disabled=false;
      newBtn.classList.remove("disabled");
      newBtn.innerHTML=`
        <span class="advisor-create-ad-icon">+</span>
        <span class="advisor-create-ad-copy">
          <strong>Criar novo anúncio</strong>
          <small>Publicar um imóvel usando 1 crédito • ${balance} disponível${balance===1?"":"is"}</small>
        </span>
        <span class="advisor-create-ad-arrow">→</span>
      `;
      newBtn.title="Criar um novo anúncio usando 1 crédito.";
    }else{
      newBtn.disabled=true;
      newBtn.classList.add("disabled");
      newBtn.innerHTML=`
        <span class="advisor-create-ad-icon">+</span>
        <span class="advisor-create-ad-copy">
          <strong>Crie seu próximo anúncio</strong>
          <small>Compre um crédito para publicar um imóvel</small>
        </span>
        <span class="advisor-create-ad-arrow">→</span>
      `;
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

function referencePointChips(selectedIds=[]){
  return referencePoints.map(point=>`
    <label class="check-chip property-option-chip">
      <input type="checkbox" name="reference_points" value="${point.id}" ${selectedIds.includes(point.id)?"checked":""}>
      <span>${escapeHTML(point.name)}</span>
    </label>
  `).join("");
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
  const referencePointIds=[];

  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el=>{
    if(el.type==="file") return;
    if(el.name==="features"){
      if(el.checked) featureIds.push(el.value);
      return;
    }
    if(el.name==="reference_points"){
      if(el.checked) referencePointIds.push(el.value);
      return;
    }
    if(el.type==="checkbox"){
      data[el.name]=!!el.checked;
      return;
    }
    data[el.name]=el.value;
  });

  data.features=featureIds;
  data.reference_points=referencePointIds;
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

    if(el.name==="reference_points"){
      const selected=Array.isArray(data.reference_points)?data.reference_points:[];
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
    wirePropertyCollaborationFields(form);
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
    const hasContract=form.querySelector('[name="has_contract"]')?.value==="true";
    const guaranteeType=form.querySelector('[name="guarantee_type"]')?.value||"deposit";
    const usesDeposit=guaranteeType==="deposit";

    form.querySelector("#distributionFields")?.classList.toggle("hidden",type==="monoambiente");
    form.querySelector("#condominiumNameField")?.classList.toggle("hidden",housing!=="condominium");
    form.querySelector("#garageDetails")?.classList.toggle("hidden",garage==="none");
    form.querySelector("#advisorAdvisoryFeeField")?.classList.toggle("hidden",!hasAdvisoryFee);
    form.querySelector("#advisorContractFields")?.classList.toggle("hidden",!hasContract);
    form.querySelector("#advisorDepositFields")?.classList.toggle("hidden",!usesDeposit);

    const advisoryInput=form.querySelector('[name="advisory_fee"]');
    if(advisoryInput) advisoryInput.required=hasAdvisoryFee;

    const contractAmount=form.querySelector('[name="contract_amount"]');
    const contractPayer=form.querySelector('[name="contract_payer"]');
    if(contractAmount) contractAmount.required=hasContract;
    if(contractPayer) contractPayer.required=hasContract;

    const depositAmount=form.querySelector('[name="security_deposit"]');
    const depositCount=form.querySelector('[name="security_deposit_count"]');
    if(depositAmount) depositAmount.required=usesDeposit;
    if(depositCount) depositCount.required=usesDeposit;

    if(!hasContract){
      if(contractAmount) contractAmount.value="";
      if(contractPayer) contractPayer.value="";
    }

    if(!usesDeposit){
      if(depositAmount) depositAmount.value="";
      if(depositCount) depositCount.value="";
      const installment=form.querySelector('[name="security_deposit_installment_allowed"]');
      const maxInstallments=form.querySelector('[name="security_deposit_max_installments"]');
      if(installment) installment.value="false";
      if(maxInstallments) maxInstallments.value="";
    }

    const total=form.querySelector('[name="security_deposit_total_display"]');
    if(total){
      const amount=Number(depositAmount?.value||0);
      const count=Number(depositCount?.value||0);
      const currency=form.querySelector('[name="currency"]')?.value||"BRL";
      total.value=usesDeposit && amount>=0 && count>0 ? money(amount*count,currency) : "";
    }
  };

  ["property_type","housing_context","garage_scope","has_advisory_fee","has_contract","guarantee_type","currency"].forEach(name=>{
    form.querySelector(`[name="${name}"]`)?.addEventListener("change",update);
  });
  ["security_deposit","security_deposit_count"].forEach(name=>{
    form.querySelector(`[name="${name}"]`)?.addEventListener("input",update);
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


function collaborationForProperty(propertyId){
  if(!propertyId) return null;
  return listingCollaborations.find(item=>item.property_id===propertyId)||null;
}

function collaborationFormHTML(property=null){
  const collaboration=collaborationForProperty(property?.id);
  const existingParticipants=collaboration?.advisor_collaboration_participants||[];
  const participantMap=new Map(existingParticipants.map(item=>[item.participant_advisor_id,item]));
  const coAdvisors=advisorDirectory.filter(item=>item.user_id!==currentUser?.id);
  const enabled=existingParticipants.length>0;

  return `
    <div class="form-section-title property-section-title">2.1 Coassessoria (opcional)</div>
    <div class="span-2 advisor-collaboration-form-card">
      <div class="collaboration-form-intro">
        <div>
          <strong>Outros assessores participam deste negócio?</strong>
          <span>Vincule somente assessores cadastrados na plataforma. Eles receberão atualizações do imóvel e verão o valor pré-acordado da própria participação.</span>
        </div>
        <label>
          <span>Coassessoria</span>
          <select name="has_collaborators">
            <option value="false" ${enabled?"":"selected"}>Não</option>
            <option value="true" ${enabled?"selected":""}>Sim</option>
          </select>
        </label>
      </div>

      <div id="advisorCollaborationFields" class="collaboration-fields ${enabled?"":"hidden"}">
        <label>Valor total a dividir entre os assessores
          <input name="collaboration_total" type="number" min="0.01" step="0.01" value="${collaboration?.total_amount??""}" placeholder="Ex.: 800">
          <small>O sistema sugere divisão igual entre o assessor principal e os coassessores. Você pode ajustar depois.</small>
        </label>

        <div class="collaboration-directory">
          <strong>Assessores cadastrados</strong>
          ${coAdvisors.length?`
            <div class="collaboration-advisor-list">
              ${coAdvisors.map(advisor=>{
                const existing=participantMap.get(advisor.user_id);
                const label=[advisor.full_name,advisor.company_name].filter(Boolean).join(" • ");
                return `
                  <label class="collaboration-advisor-choice">
                    <input
                      type="checkbox"
                      name="collab_advisor_${advisor.user_id}"
                      value="${advisor.user_id}"
                      data-collab-advisor
                      data-advisor-name="${escapeHTML(advisor.full_name)}"
                      data-existing-share="${existing?.agreed_amount??""}"
                      ${existing?"checked":""}
                    >
                    <span>
                      <strong>${escapeHTML(label)}</strong>
                      ${advisor.city?`<small>${escapeHTML(advisor.city)}</small>`:""}
                    </span>
                  </label>
                `;
              }).join("")}
            </div>
          `:'<div class="advisor-empty-compact">Ainda não existem outros assessores cadastrados para vincular.</div>'}
        </div>

        <div id="collaborationShareRows" class="collaboration-share-rows"></div>
        <div class="collaboration-owner-share">
          <span>Sua parte estimada</span>
          <strong id="collaborationOwnerShare">${money(collaboration?.owner_share_amount||0,collaboration?.currency||property?.currency||"BRL")}</strong>
        </div>
        <p class="collaboration-private-note">🔒 A divisão é privada entre os assessores participantes e não aparece no anúncio público.</p>
      </div>
    </div>
  `;
}

function selectedCollaborationAdvisors(form){
  return [...form.querySelectorAll("[data-collab-advisor]:checked")].map(input=>({
    advisor_id:input.value,
    name:input.dataset.advisorName||"Assessor",
    existing_share:Number(input.dataset.existingShare||0)
  }));
}

function updateCollaborationOwnerShare(form){
  const total=Number(form.querySelector('[name="collaboration_total"]')?.value||0);
  const currency=form.querySelector('[name="currency"]')?.value||"BRL";
  const selected=selectedCollaborationAdvisors(form);
  const participantTotal=selected.reduce((sum,item)=>{
    const input=form.querySelector(`[name="collab_share_${item.advisor_id}"]`);
    return sum+Number(input?.value||0);
  },0);
  const owner=Math.max(0,total-participantTotal);
  const target=form.querySelector("#collaborationOwnerShare");
  if(target) target.textContent=money(owner,currency);
}

function renderCollaborationShares(form,{equalize=false}={}){
  const root=form.querySelector("#collaborationShareRows");
  if(!root) return;

  const selected=selectedCollaborationAdvisors(form);
  const total=Number(form.querySelector('[name="collaboration_total"]')?.value||0);
  const currency=form.querySelector('[name="currency"]')?.value||"BRL";
  const previous=new Map(
    [...root.querySelectorAll("[data-collab-share]")].map(input=>[input.dataset.advisorId,input.value])
  );
  const equal=selected.length>=1 && total>0 ? total/(selected.length+1) : 0;

  root.innerHTML=selected.length?`
    <div class="collaboration-share-head">
      <strong>Divisão pré-acordada</strong>
      <small>Valores individuais podem ser ajustados.</small>
    </div>
    ${selected.map(item=>{
      let value="";
      if(equalize) value=equal?equal.toFixed(2):"";
      else if(previous.has(item.advisor_id)) value=previous.get(item.advisor_id);
      else if(item.existing_share>0) value=item.existing_share.toFixed(2);
      else value=equal?equal.toFixed(2):"";
      return `
        <label class="collaboration-share-row">
          <span>${escapeHTML(item.name)}</span>
          <div>
            <small>${currency==="PYG"?"₲":"R$"}</small>
            <input
              type="number"
              min="0"
              step="0.01"
              name="collab_share_${item.advisor_id}"
              data-collab-share
              data-advisor-id="${item.advisor_id}"
              value="${value}"
            >
          </div>
        </label>
      `;
    }).join("")}
  `:"";

  root.querySelectorAll("[data-collab-share]").forEach(input=>{
    input.addEventListener("input",()=>updateCollaborationOwnerShare(form));
  });
  updateCollaborationOwnerShare(form);
}

function wirePropertyCollaborationFields(form){
  if(!form) return;
  const toggle=form.querySelector('[name="has_collaborators"]');
  const fields=form.querySelector("#advisorCollaborationFields");
  const total=form.querySelector('[name="collaboration_total"]');

  const refreshVisibility=()=>{
    const enabled=toggle?.value==="true";
    fields?.classList.toggle("hidden",!enabled);
    if(enabled) renderCollaborationShares(form);
  };

  if(form.dataset.collaborationWired!=="1"){
    toggle?.addEventListener("change",()=>{
      refreshVisibility();
      if(toggle.value==="true") renderCollaborationShares(form,{equalize:true});
    });
    total?.addEventListener("input",()=>renderCollaborationShares(form,{equalize:true}));
    form.querySelector('[name="currency"]')?.addEventListener("change",()=>renderCollaborationShares(form));
    form.querySelectorAll("[data-collab-advisor]").forEach(input=>{
      input.addEventListener("change",()=>renderCollaborationShares(form,{equalize:true}));
    });
    form.dataset.collaborationWired="1";
  }

  refreshVisibility();
}

function collectCollaborationData(form){
  const enabled=form.querySelector('[name="has_collaborators"]')?.value==="true";
  if(!enabled) return {enabled:false,total:0,participants:[]};

  const selected=selectedCollaborationAdvisors(form);
  const total=Number(form.querySelector('[name="collaboration_total"]')?.value||0);

  if(!selected.length) throw new Error("Selecione pelo menos um coassessor.");
  if(!(total>0)) throw new Error("Informe o valor total que será dividido entre os assessores.");

  const participants=selected.map(item=>({
    advisor_id:item.advisor_id,
    amount:Number(form.querySelector(`[name="collab_share_${item.advisor_id}"]`)?.value||0)
  }));

  if(participants.some(item=>item.amount<0)) throw new Error("Confira os valores da divisão entre assessores.");
  const sum=participants.reduce((acc,item)=>acc+item.amount,0);
  if(sum>total+0.009) throw new Error("A soma dos coassessores não pode ser maior que o valor total da divisão.");

  return {enabled:true,total,participants};
}

async function savePropertyCollaboration(propertyId,form,currency){
  let collaboration;
  try{
    collaboration=collectCollaborationData(form);
  }catch(err){
    return {error:err};
  }

  const {error,data}=await db.rpc("save_advisor_collaboration",{
    p_property_id:propertyId,
    p_total_amount:collaboration.enabled?collaboration.total:0,
    p_currency:currency||"BRL",
    p_participants:collaboration.enabled?collaboration.participants:[]
  });

  return {error,data};
}


function propertyModal(property=null){
  pendingPropertyFiles=[];
  pendingPropertyCoverExplicit=false;

  if(!property && creditBalance()<=0){
    alert("Seu saldo de créditos está zerado. Compre créditos para publicar um novo imóvel.");
    return;
  }

  const selectedIds=(property?.property_features||[]).map(x=>x.feature_id);
  const selectedReferencePointIds=(property?.property_reference_points||[]).map(x=>x.reference_point_id);
  const furnitureChips=featureChips("furniture",selectedIds);
  const includedChips=featureChips("included",selectedIds);
  const securityChips=featureChips("security",selectedIds);
  const nearbyChips=featureChips("nearby",selectedIds);
  const referencePointOptions=referencePointChips(selectedReferencePointIds);

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

      <input type="hidden" name="status" value="available">
      <div class="property-options-help">
        Para finalizar uma locação, use “Marcar como alugado” na lista de imóveis. O recibo será obrigatório e o anúncio será excluído após a confirmação.
      </div>

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

      <label>Garantia exigida
        <select name="guarantee_type" required>
          <option value="deposit" ${(property?.guarantee_type||"deposit")==="deposit"?"selected":""}>Caução</option>
          <option value="guarantor" ${property?.guarantee_type==="guarantor"?"selected":""}>Fiador</option>
        </select>
      </label>

      <label>Tempo mínimo de contrato
        <select name="minimum_contract_term" required>
          <option value="none" ${(property?.minimum_contract_term||"none")==="none"?"selected":""}>Sem tempo mínimo</option>
          <option value="6_months" ${property?.minimum_contract_term==="6_months"?"selected":""}>6 meses</option>
          <option value="12_months" ${property?.minimum_contract_term==="12_months"?"selected":""}>1 ano</option>
        </select>
      </label>

      <div id="advisorDepositFields" class="span-2 conditional-subgrid ${property?.guarantee_type==="guarantor"?"hidden":""}">
        <label>Quantidade de cauções
          <input name="security_deposit_count" type="number" min="1" max="24" step="1" value="${property?.security_deposit_count??(property?.security_deposit!=null?1:"")}" placeholder="Ex.: 2">
        </label>

        <label>Valor de cada caução
          <input name="security_deposit" type="number" min="0" step="1" value="${property?.security_deposit??""}" placeholder="Ex.: 1500">
        </label>

        <label>Valor total das cauções
          <input name="security_deposit_total_display" type="text" readonly value="">
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
      </div>

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

      <label>Possui contrato?
        <select name="has_contract">
          <option value="false" ${!property?.has_contract?"selected":""}>Não</option>
          <option value="true" ${property?.has_contract?"selected":""}>Sim</option>
        </select>
      </label>

      <div id="advisorContractFields" class="span-2 conditional-subgrid ${property?.has_contract?"":"hidden"}">
        <label>Valor do contrato
          <input name="contract_amount" type="number" min="0" step="1" value="${property?.contract_amount??""}" placeholder="Ex.: 250">
        </label>
        <label>Quem paga o contrato?
          <select name="contract_payer">
            <option value="">Selecione</option>
            <option value="owner" ${property?.contract_payer==="owner"?"selected":""}>Proprietário</option>
            <option value="tenant" ${property?.contract_payer==="tenant"?"selected":""}>Inquilino</option>
          </select>
        </label>
      </div>

      <label>Forma de fechamento
        <select name="closing_mode">
          <option value="advisor" ${property?.closing_mode!=="direct_owner"?"selected":""}>Via assessoria</option>
          <option value="direct_owner" ${property?.closing_mode==="direct_owner"?"selected":""}>Direto com o proprietário</option>
        </select>
      </label>

      ${collaborationFormHTML(property)}

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

      <div class="form-section-title property-section-title">8. Pontos de referência (opcional)</div>
      <div class="span-2 property-options-help">Selecione um ou vários locais cadastrados pela administração que façam sentido para este imóvel. Se não quiser, deixe tudo desmarcado.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${referencePointOptions || '<span class="muted">Nenhum ponto de referência cadastrado pela administração.</span>'}
      </div>

      <div class="form-section-title property-section-title">9. Localização privada</div>

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

      <div class="form-section-title property-section-title">10. Fotos, vídeo e descrição</div>

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
  wirePropertyCollaborationFields($("#advisorPropertyForm"));
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

  const enteredMapsUrl=String(fd.get("google_maps_url")||"").trim();
  const googleMapsUrl=enteredMapsUrl || existing?.google_maps_url || null;
  let latitude=existing?.latitude??null;
  let longitude=existing?.longitude??null;

  const mapsUrlChanged=!!existing && String(existing.google_maps_url||"").trim()!==String(googleMapsUrl||"").trim();
  const needsLocationResolve=!!googleMapsUrl && (!existing || mapsUrlChanged || latitude==null || longitude==null);

  if(needsLocationResolve){
    msg.textContent="1/4 • Validando localização...";
    const resolved=await withTimeout(
      db.functions.invoke("resolve-maps-link",{body:{url:googleMapsUrl}}),
      15000,
      "Leitura do Google Maps"
    );
    if(resolved.error || resolved.data?.error){
      msg.textContent=resolved.data?.error || resolved.error?.message || "Não foi possível ler o link do Google Maps.";
      return false;
    }
    if(resolved.data?.latitude==null || resolved.data?.longitude==null){
      msg.textContent="Não foi possível identificar as coordenadas desse link do Google Maps. Gere um novo link em Compartilhar → Copiar link e tente novamente.";
      return false;
    }
    latitude=Number(resolved.data.latitude);
    longitude=Number(resolved.data.longitude);
  }

  const row={
    title,
    slug:existing?.slug || title.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")+"-"+Date.now().toString(36),
    property_type:fd.get("property_type"),
    description:String(fd.get("description")||"").trim()||null,
    price:Number(fd.get("price")),
    currency:fd.get("currency")||"BRL",
    guarantee_type:fd.get("guarantee_type")||"deposit",
    security_deposit:fd.get("guarantee_type")==="deposit" && fd.get("security_deposit")!==""?Number(fd.get("security_deposit")):null,
    security_deposit_count:fd.get("guarantee_type")==="deposit" && fd.get("security_deposit_count")?Number(fd.get("security_deposit_count")):null,
    security_deposit_installment_allowed:fd.get("guarantee_type")==="deposit" && fd.get("security_deposit_installment_allowed")==="true",
    security_deposit_max_installments:fd.get("guarantee_type")==="deposit" && fd.get("security_deposit_installment_allowed")==="true" && fd.get("security_deposit_max_installments")?Number(fd.get("security_deposit_max_installments")):null,
    minimum_contract_term:fd.get("minimum_contract_term")||"none",
    has_contract:fd.get("has_contract")==="true",
    contract_amount:fd.get("has_contract")==="true" && fd.get("contract_amount")!==""?Number(fd.get("contract_amount")):null,
    contract_payer:fd.get("has_contract")==="true" ? (fd.get("contract_payer")||null) : null,
    closing_mode:fd.get("closing_mode"),
    advertiser_role:fd.get("advertiser_role")||"broker",
    advisor_owner_id:String(fd.get("advisor_owner_id")||"").trim()||null,
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
    status:"available"
  };

  const selectedFeatureIds=[...form.querySelectorAll('input[name="features"]:checked')].map(el=>el.value);
  const selectedReferencePointIds=[...form.querySelectorAll('input[name="reference_points"]:checked')].map(el=>el.value);

  try{
    collectCollaborationData(form);
  }catch(err){
    msg.textContent=err?.message||"Confira a divisão da coassessoria.";
    return false;
  }

  // EDITAR: mantém identidade e prazo do anúncio original.
  if(existing){
    msg.textContent="2/4 • Salvando alterações...";

    const updateRow={
      price:row.price,
      currency:row.currency,
      guarantee_type:row.guarantee_type,
      security_deposit:row.security_deposit,
      security_deposit_count:row.security_deposit_count,
      security_deposit_installment_allowed:row.security_deposit_installment_allowed,
      security_deposit_max_installments:row.security_deposit_max_installments,
      minimum_contract_term:row.minimum_contract_term,
      has_contract:row.has_contract,
      contract_amount:row.contract_amount,
      contract_payer:row.contract_payer,
      closing_mode:row.closing_mode,
      advertiser_role:row.advertiser_role,
      has_advisory_fee:row.has_advisory_fee,
      advisory_fee:row.advisory_fee,
      contact_whatsapp:row.contact_whatsapp,
      furnished:row.furnished
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

    const clearReferences=await db.from("property_reference_points").delete().eq("property_id",existing.id);
    if(clearReferences.error){
      console.warn("Não foi possível limpar pontos de referência:",clearReferences.error);
    }else if(selectedReferencePointIds.length){
      const referenceInsert=await db.from("property_reference_points").insert(
        selectedReferencePointIds.map(reference_point_id=>({property_id:existing.id,reference_point_id}))
      );
      if(referenceInsert.error){
        console.warn("Não foi possível atualizar os pontos de referência:",referenceInsert.error);
      }
    }

    msg.textContent="3/4 • Atualizando coassessoria...";
    const collaborationSave=await savePropertyCollaboration(existing.id,form,row.currency);
    if(collaborationSave.error){
      msg.textContent="As alterações do imóvel foram salvas, mas a coassessoria não foi atualizada: "+(collaborationSave.error.message||"erro desconhecido");
      return false;
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

    if(selectedReferencePointIds.length){
      const referenceInsert=await db.from("property_reference_points").insert(
        selectedReferencePointIds.map(reference_point_id=>({property_id:propertyId,reference_point_id}))
      );
      if(referenceInsert.error){
        console.warn("Imóvel publicado, mas os pontos de referência não foram vinculados:",referenceInsert.error);
      }
    }

    const collaborationSave=await savePropertyCollaboration(propertyId,form,row.currency);
    if(collaborationSave.error){
      console.warn("Imóvel publicado, mas a coassessoria não foi salva:",collaborationSave.error);
      msg.textContent="Imóvel publicado. A coassessoria não foi salva: "+(collaborationSave.error.message||"erro desconhecido")+". Você pode editar o anúncio e tentar novamente.";
    }else{
      msg.textContent="4/4 • Imóvel publicado com sucesso.";
    }
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
  if(paymentRequestInFlight) return false;
  paymentRequestInFlight=true;

  showAdvisorModal(`
    <div class="pix-generation-loading" role="status" aria-live="polite">
      <div class="pix-generation-spinner" aria-hidden="true"></div>
      <strong>Gerando seu PIX...</strong>
      <span>Aguarde a cobrança ser criada. Não clique novamente.</span>
    </div>
  `);

  try{
    const {data,error}=await db.functions.invoke("create-advisor-pix",{body:{plan_id:planId}});

    if(error || !data || data.error){
      showAdvisorModal(`
        <div class="modal-head">
          <div><p class="eyebrow">PAGAMENTO PIX</p><h2>Não foi possível gerar o PIX</h2></div>
          <button class="icon-btn" data-close>✕</button>
        </div>
        <div class="pix-payment-status">
          <strong>Tente novamente.</strong>
          <span>${escapeHTML(data?.error || error?.message || "A integração PIX ainda está sendo finalizada.")}</span>
        </div>
      `);
      return false;
    }

    showAdvisorModal(`
      <div class="modal-head"><div><p class="eyebrow">PAGAMENTO PIX</p><h2>Concluir pagamento</h2></div><button class="icon-btn" data-close>✕</button></div>
      <div class="pix-box">
        <strong>Total: ${money(data.amount,"BRL")}</strong>
        <span class="promo-label">Após a confirmação, os créditos entram automaticamente no seu saldo.</span>
        ${data.qr_code_base64?`<img class="pix-qr" src="data:image/png;base64,${data.qr_code_base64}" alt="QR Code PIX">`:""}
        ${data.qr_code?`<textarea id="pixCopy" readonly>${escapeHTML(data.qr_code)}</textarea><button class="btn primary" id="copyPix">Copiar PIX</button>`:""}
        <div id="pixStatus" class="pix-payment-status"><strong>Aguardando confirmação do pagamento...</strong><span>Assim que o Mercado Pago confirmar, esta tela será atualizada automaticamente.</span></div>
      </div>
    `);

    $("#copyPix")?.addEventListener("click",async()=>{
      await navigator.clipboard.writeText($("#pixCopy").value);
      $("#copyPix").textContent="PIX copiado ✓";
    });

    if(data.subscription_id) watchPaymentStatus(data.subscription_id);
    return true;
  }catch(err){
    console.error("Erro ao gerar PIX:",err);
    showAdvisorModal(`
      <div class="modal-head">
        <div><p class="eyebrow">PAGAMENTO PIX</p><h2>Não foi possível gerar o PIX</h2></div>
        <button class="icon-btn" data-close>✕</button>
      </div>
      <div class="pix-payment-status">
        <strong>Tente novamente.</strong>
        <span>${escapeHTML(err?.message || "Houve uma falha ao criar a cobrança.")}</span>
      </div>
    `);
    return false;
  }finally{
    paymentRequestInFlight=false;
  }
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
  const openCreditStore=e.target.closest("[data-open-credit-store]");
  if(openCreditStore){
    $("#advisorDashboardView")?.classList.add("hidden");
    $("#advisorHowItWorks")?.classList.add("hidden");
    $(".advisor-panel-tabs")?.classList.add("hidden");
    $("#advisorCreditStore")?.classList.remove("hidden");
    window.scrollTo({top:0,behavior:"smooth"});
    return;
  }

  const closeCreditStore=e.target.closest("[data-close-credit-store]");
  if(closeCreditStore){
    $("#advisorCreditStore")?.classList.add("hidden");
    $(".advisor-panel-tabs")?.classList.remove("hidden");
    document.querySelectorAll("[data-advisor-view]").forEach(btn=>btn.classList.toggle("active",btn.dataset.advisorView==="dashboard"));
    $("#advisorDashboardView")?.classList.remove("hidden");
    $("#advisorHowItWorks")?.classList.add("hidden");
    window.scrollTo({top:0,behavior:"smooth"});
    return;
  }

  const buy=e.target.closest("[data-buy]");
  if(buy){
    if(paymentRequestInFlight) return;
    buy.disabled=true;
    const originalText=buy.textContent;
    buy.textContent="Gerando PIX...";
    const ok=await startPayment(buy.dataset.buy);
    if(!ok && document.body.contains(buy)){
      buy.disabled=false;
      buy.textContent=originalText;
    }
    return;
  }
  const viewBtn=e.target.closest("[data-advisor-view]");
  if(viewBtn){
    const view=viewBtn.dataset.advisorView;
    document.querySelectorAll("[data-advisor-view]").forEach(btn=>btn.classList.toggle("active",btn===viewBtn));
    $("#advisorDashboardView")?.classList.toggle("hidden",view!=="dashboard");
    $("#advisorHowItWorks")?.classList.toggle("hidden",view!=="how");
    window.scrollTo({top:0,behavior:"smooth"});
  }


  const newOwner=e.target.closest("[data-new-owner], [data-new-owner-from-property]");
  if(newOwner){
    ownerModal();
    return;
  }

  const editOwner=e.target.closest("[data-edit-owner]");
  if(editOwner){
    const owner=ownerById(editOwner.dataset.editOwner);
    if(owner) ownerModal(owner);
    return;
  }

  const deleteOwner=e.target.closest("[data-delete-owner]");
  if(deleteOwner){
    const owner=ownerById(deleteOwner.dataset.deleteOwner);
    if(owner && confirm(`Excluir ${owner.full_name} da sua carteira de proprietários? Os imóveis continuarão salvos, apenas sem o vínculo.`)){
      const {error}=await db.from("advisor_owners").delete().eq("id",owner.id).eq("advisor_id",currentUser.id);
      if(error) alert(error.message);
      else{
        await loadData();
        renderOwners();
        renderManagementDashboard();
      }
    }
    return;
  }

  const newFinancial=e.target.closest("[data-new-financial-entry]");
  if(newFinancial){
    financialEntryModal();
    return;
  }

  const editFinancial=e.target.closest("[data-edit-financial-entry]");
  if(editFinancial){
    const row=financialEntries.find(item=>item.id===editFinancial.dataset.editFinancialEntry);
    if(row) financialEntryModal(row);
    return;
  }

  const deleteFinancial=e.target.closest("[data-delete-financial-entry]");
  if(deleteFinancial && confirm("Excluir este lançamento financeiro?")){
    const {error}=await db.from("advisor_financial_entries")
      .delete()
      .eq("id",deleteFinancial.dataset.deleteFinancialEntry)
      .eq("advisor_id",currentUser.id);
    if(error) alert(error.message);
    else{
      await loadData();
      renderFinance();
      renderManagementDashboard();
    }
    return;
  }

  const newServiceReceipt=e.target.closest("[data-new-service-receipt]");
  if(newServiceReceipt){
    serviceReceiptModal();
    return;
  }

  const generateService=e.target.closest("[data-generate-service-receipt]");
  if(generateService){
    const row=serviceReceipts.find(item=>item.id===generateService.dataset.generateServiceReceipt);
    if(row) generateServiceReceiptPdf(row);
    return;
  }

  const editService=e.target.closest("[data-edit-service-receipt]");
  if(editService){
    const row=serviceReceipts.find(item=>item.id===editService.dataset.editServiceReceipt);
    if(row) serviceReceiptModal(row);
    return;
  }

  const deleteService=e.target.closest("[data-delete-service-receipt]");
  if(deleteService && confirm("Excluir este recibo de assessoria?")){
    const {error}=await db.from("advisor_service_receipts")
      .delete()
      .eq("id",deleteService.dataset.deleteServiceReceipt)
      .eq("advisor_id",currentUser.id);
    if(error) alert(error.message);
    else{
      await loadData();
      renderServiceReceipts();
      renderFinance();
      renderManagementDashboard();
    }
    return;
  }


  const newRental=e.target.closest("[data-new-rental-control]");
  if(newRental) rentalControlModal();

  const pdfRental=e.target.closest("[data-generate-rental-pdf]");
  if(pdfRental){
    const row=rentalControls.find(r=>r.id===pdfRental.dataset.generateRentalPdf);
    if(row) generateRentalReceiptPdf(row);
    return;
  }

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

    if(e.target.closest("#shareAdvisorCatalog")) await shareAdvisorCatalog();
  if(e.target.closest("#shareAdvisorCatalogMain")) await shareAdvisorCatalog();
  const copyCatalog=e.target.closest("#copyAdvisorCatalog");
  if(copyCatalog) await copyAdvisorCatalogLink(copyCatalog);
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
  const markRented=e.target.closest("[data-mark-rented-ad]");
  if(markRented){
    const item=properties.find(p=>p.id===markRented.dataset.markRentedAd);
    if(item) rentalReceiptModal(item);
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
  if(e.target.id==="advisorOwnerForm") await saveOwner(e.target);
  if(e.target.id==="advisorFinancialEntryForm") await saveFinancialEntry(e.target);
  if(e.target.id==="advisorServiceReceiptForm") await saveServiceReceipt(e.target);
  if(e.target.id==="advisorRentalControlForm") await saveRentalControl(e.target);
  if(e.target.id==="advisorRentalReceiptForm") await markPropertyRented(e.target);
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