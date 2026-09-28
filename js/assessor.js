import { db, STORAGE_BUCKET } from "./config.js";
import { $, escapeHTML, money, propertyTypeLabel, statusLabel } from "./common.js";

let currentUser=null;
let profile=null;
let plans=[];
let subscriptions=[];
let properties=[];

function fmtDate(v){
  if(!v) return "—";
  return new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(new Date(v));
}
function activeSubscription(){
  return subscriptions.find(s=>s.status==="active" && s.ends_at && new Date(s.ends_at)>new Date()) || null;
}
function latestRenewable(){
  return [...subscriptions]
    .filter(s=>["active","expired"].includes(s.status))
    .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0] || null;
}
function adCountFor(subId){
  return properties.filter(p=>p.advisor_subscription_id===subId).length;
}
function closeAdvisorModal(){
  $("#advisorModal").classList.add("hidden");
  $("#advisorModal").innerHTML="";
}
function showAdvisorModal(html){
  $("#advisorModal").innerHTML='<div class="modal-card">'+html+'</div>';
  $("#advisorModal").classList.remove("hidden");
}

async function ensureProfile(user){
  const {data}=await db.from("advisor_profiles").select("*").eq("user_id",user.id).maybeSingle();
  if(data){profile=data;return;}
  const meta=user.user_metadata||{};
  const row={
    user_id:user.id,
    full_name:meta.full_name||user.email?.split("@")[0]||"Assessor",
    whatsapp:String(meta.whatsapp||"").replace(/\D/g,"")||null,
    company_name:meta.company_name||null,
    city:meta.city||null
  };
  const res=await db.from("advisor_profiles").insert(row).select("*").single();
  if(!res.error) profile=res.data;
}

async function loadData(){
  const [pl,sub,ads]=await Promise.all([
    db.from("advertising_plans").select("*").eq("active",true).order("sort_order"),
    db.from("advisor_subscriptions").select("*, advertising_plans(*)").order("created_at",{ascending:false}),
    db.from("properties").select("*, property_media(*)").eq("advisor_id",currentUser.id).order("created_at",{ascending:false})
  ]);
  plans=pl.data||[];
  subscriptions=sub.data||[];
  properties=ads.data||[];
}

function renderPlans(){
  const active=activeSubscription();
  const renewable=latestRenewable();
  $("#advisorPlans").innerHTML=plans.map(plan=>{
    const isActive=active?.plan_id===plan.id;
    const canRenew=renewable?.plan_id===plan.id;
    const promo=(Number(plan.price)*0.9).toFixed(2).replace(".",",");
    return `
      <article class="advisor-plan-card ${isActive?"active":""}">
        <span class="advisor-plan-badge">${plan.ad_limit} anúncio${plan.ad_limit>1?"s":""}</span>
        <h3>${escapeHTML(plan.name)}</h3>
        <div class="advisor-plan-price">${money(plan.price,"BRL")}</div>
        <p>Validade de ${plan.validity_days} dias.</p>
        ${isActive?`<div class="plan-active-note">Ativo até ${fmtDate(active.ends_at)} • ${adCountFor(active.id)}/${plan.ad_limit} usados</div>`:""}
        ${canRenew?`
          <div class="renew-price">
            <span>Renovação promocional</span>
            <div><del>${money(plan.price,"BRL")}</del><strong>R$ ${promo}</strong></div>
          </div>
          <button class="btn whatsapp full" data-buy="${plan.id}" data-renew="${renewable.id}">Renovar com 10% OFF</button>
        `:`
          <button class="btn primary full" data-buy="${plan.id}">Comprar via PIX</button>
        `}
      </article>`;
  }).join("");
}

function renderExpiredNotice(){
  const expired=properties.filter(p=>p.listing_expires_at && new Date(p.listing_expires_at)<=new Date());
  const box=$("#advisorExpiredNotice");
  if(!expired.length){box.innerHTML="";return;}
  box.innerHTML=`<div class="advisor-expired-alert"><strong>${expired.length} anúncio${expired.length>1?"s foram":" foi"} retirado${expired.length>1?"s":""} do ar.</strong><span>O período de 30 dias expirou. Renove o pacote abaixo para republicar seus anúncios.</span></div>`;
}

function renderAds(){
  if(!properties.length){
    $("#advisorAds").innerHTML='<div class="empty-state"><strong>Nenhum anúncio cadastrado.</strong><span>Compre um pacote e publique seu primeiro imóvel.</span></div>';
    return;
  }
  $("#advisorAds").innerHTML=`
    <div class="advisor-ad-list">
      ${properties.map(p=>{
        const expired=p.listing_expires_at && new Date(p.listing_expires_at)<=new Date();
        return `
          <div class="advisor-ad-row">
            <div>
              <strong>${escapeHTML(p.title)}</strong>
              <span>${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))}</span>
              <small>${expired?"Expirado":statusLabel(p.status)} • validade: ${fmtDate(p.listing_expires_at)}</small>
            </div>
            <div class="advisor-ad-actions">
              <span class="pill ${expired?"pending":"paid"}">${expired?"FORA DO AR":"PUBLICADO"}</span>
              <button class="btn danger compact" data-delete-ad="${p.id}">Excluir</button>
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

function renderPanel(){
  $("#advisorWelcome").textContent=profile?.company_name || profile?.full_name || "Meus anúncios";
  renderExpiredNotice();
  renderPlans();
  renderAds();
}

function propertyModal(){
  const active=activeSubscription();
  if(!active){
    alert("Você precisa de um pacote ativo para publicar um imóvel.");
    return;
  }
  const plan=active.advertising_plans;
  if(adCountFor(active.id)>=Number(plan.ad_limit)){
    alert("Você já utilizou todos os anúncios disponíveis neste pacote.");
    return;
  }
  showAdvisorModal(`
    <div class="modal-head"><div><p class="eyebrow">NOVO ANÚNCIO</p><h2>Cadastrar imóvel</h2></div><button class="icon-btn" data-close>✕</button></div>
    <form id="advisorPropertyForm" class="form-grid">
      <label>Título<input name="title" required></label>
      <label>Tipo<select name="property_type"><option value="apartamento">Apartamento</option><option value="casa">Casa</option><option value="monoambiente">Monoambiente</option><option value="kitnet">Kitnet</option><option value="outro">Outro</option></select></label>
      <label>Valor mensal<input name="price" type="number" min="0" step="0.01" required></label>
      <label>Caução<input name="security_deposit" type="number" min="0" step="0.01"></label>
      <label>Parcelamento da caução<select name="security_deposit_installment_allowed"><option value="false">Não</option><option value="true">Sim</option></select></label>
      <label>Máximo de parcelas<input name="security_deposit_max_installments" type="number" min="2" max="24"></label>
      <label>Fechamento<select name="closing_mode"><option value="advisor">Via assessoria</option><option value="direct_owner">Direto com o proprietário</option></select></label>
      <label>WhatsApp do anúncio<input name="contact_whatsapp" inputmode="tel" required value="${escapeHTML(profile?.whatsapp||"")}"></label>
      <label>Quartos<input name="bedrooms" type="number" min="0"></label>
      <label>Banheiros<input name="bathrooms" type="number" min="0"></label>
      <label>Mobília<select name="furnished"><option value="false">Sem mobília</option><option value="true">Mobiliado</option></select></label>
      <label>Bairro<input name="neighborhood"></label>
      <label>Cidade<input name="city" value="${escapeHTML(profile?.city||"")}"></label>
      <label class="span-2">Endereço completo<input name="address"></label>
      <label>Latitude<input name="latitude" type="number" step="0.0000001"></label>
      <label>Longitude<input name="longitude" type="number" step="0.0000001"></label>
      <label>Mostrar localização exata?<select name="show_exact_location"><option value="false">Não</option><option value="true">Sim</option></select></label>
      <label>Status<select name="status"><option value="available">Disponível</option><option value="rented">Alugado</option></select></label>
      <label class="span-2">Descrição<textarea name="description"></textarea></label>
      <label class="span-2">Fotos<input name="images" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple required></label>
      <div class="form-actions"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn primary" type="submit">Publicar imóvel</button></div>
      <div id="advisorPropertyMessage" class="span-2 form-message"></div>
    </form>`);
}

async function saveProperty(form){
  const active=activeSubscription();
  if(!active) return;
  const fd=new FormData(form);
  const title=String(fd.get("title")||"").trim();
  const row={
    title,
    slug:title.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")+"-"+Date.now().toString(36),
    property_type:fd.get("property_type"),
    description:String(fd.get("description")||"").trim()||null,
    price:Number(fd.get("price")),
    security_deposit:fd.get("security_deposit")?Number(fd.get("security_deposit")):null,
    security_deposit_installment_allowed:fd.get("security_deposit_installment_allowed")==="true",
    security_deposit_max_installments:fd.get("security_deposit_installment_allowed")==="true" && fd.get("security_deposit_max_installments")?Number(fd.get("security_deposit_max_installments")):null,
    closing_mode:fd.get("closing_mode"),
    contact_whatsapp:String(fd.get("contact_whatsapp")||"").replace(/\D/g,""),
    bedrooms:fd.get("bedrooms")?Number(fd.get("bedrooms")):null,
    bathrooms:fd.get("bathrooms")?Number(fd.get("bathrooms")):null,
    furnished:fd.get("furnished")==="true",
    neighborhood:String(fd.get("neighborhood")||"").trim()||null,
    city:String(fd.get("city")||"").trim()||null,
    address:String(fd.get("address")||"").trim()||null,
    latitude:fd.get("latitude")?Number(fd.get("latitude")):null,
    longitude:fd.get("longitude")?Number(fd.get("longitude")):null,
    show_exact_location:fd.get("show_exact_location")==="true",
    status:fd.get("status"),
    is_published:true,
    advisor_id:currentUser.id,
    advisor_subscription_id:active.id
  };
  const msg=$("#advisorPropertyMessage");
  msg.textContent="Publicando...";
  const ins=await db.from("properties").insert(row).select("id").single();
  if(ins.error){msg.textContent=ins.error.message;return;}
  const files=[...form.querySelector('input[name="images"]').files];
  let first=true;
  for(const file of files){
    const safe=file.name.replace(/[^A-Za-z0-9._-]/g,"_");
    const path=`${currentUser.id}/${ins.data.id}/${crypto.randomUUID()}-${safe}`;
    const up=await db.storage.from(STORAGE_BUCKET).upload(path,file,{cacheControl:"3600",upsert:false});
    if(up.error){msg.textContent=up.error.message;return;}
    await db.from("property_media").insert({property_id:ins.data.id,media_type:"image",storage_path:path,is_cover:first,sort_order:first?0:10});
    first=false;
  }
  closeAdvisorModal();
  await loadData();
  renderPanel();
}

async function startPayment(planId,renewalOf=null){
  const cpf=prompt("Informe o CPF do pagador para gerar o PIX (somente números):");
  if(!cpf) return;
  const {data,error}=await db.functions.invoke("create-advisor-pix",{body:{plan_id:planId,renewal_of:renewalOf,cpf}});
  if(error || !data || data.error){
    alert(data?.error || error?.message || "A integração PIX ainda está sendo finalizada.");
    return;
  }
  showAdvisorModal(`
    <div class="modal-head"><div><p class="eyebrow">PAGAMENTO PIX</p><h2>Concluir pagamento</h2></div><button class="icon-btn" data-close>✕</button></div>
    <div class="pix-box">
      <strong>Total: ${money(data.amount,"BRL")}</strong>
      ${data.discount_percent?'<span class="promo-label">10% de desconto aplicado</span>':""}
      ${data.qr_code_base64?`<img class="pix-qr" src="data:image/png;base64,${data.qr_code_base64}" alt="QR Code PIX">`:""}
      ${data.qr_code?`<textarea id="pixCopy" readonly>${escapeHTML(data.qr_code)}</textarea><button class="btn primary" id="copyPix">Copiar PIX</button>`:""}
      <p class="muted">Após a confirmação do Mercado Pago, o pacote é liberado automaticamente.</p>
    </div>`);
  $("#copyPix")?.addEventListener("click",async()=>{await navigator.clipboard.writeText($("#pixCopy").value);$("#copyPix").textContent="PIX copiado ✓";});
}

async function boot(){
  const {data:{user}}=await db.auth.getUser();
  currentUser=user;
  if(!user){
    $("#advisorAuth").classList.remove("hidden");
    $("#advisorPanel").classList.add("hidden");
    return;
  }
  await ensureProfile(user);
  await loadData();
  $("#advisorAuth").classList.add("hidden");
  $("#advisorPanel").classList.remove("hidden");
  renderPanel();
}

document.addEventListener("click",async e=>{
  const tab=e.target.closest("[data-auth-tab]");
  if(tab){
    document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b===tab));
    $("#advisorLoginForm").classList.toggle("hidden",tab.dataset.authTab!=="login");
    $("#advisorSignupForm").classList.toggle("hidden",tab.dataset.authTab!=="signup");
  }
  const buy=e.target.closest("[data-buy]");
  if(buy) await startPayment(buy.dataset.buy,buy.dataset.renew||null);
  if(e.target.closest("#newAdvisorProperty")) propertyModal();
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
  if(e.target.id==="advisorPropertyForm") await saveProperty(e.target);
});

$("#advisorLoginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=$("#advisorAuthMessage"); msg.textContent="Entrando...";
  const {error}=await db.auth.signInWithPassword({email:$("#advisorLoginEmail").value.trim(),password:$("#advisorLoginPassword").value});
  if(error){msg.textContent="E-mail ou senha incorretos.";return;}
  msg.textContent="";await boot();
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
  const {data,error}=await db.auth.signUp({email:$("#advisorSignupEmail").value.trim(),password:$("#advisorSignupPassword").value,options:{data:meta}});
  if(error){msg.textContent=error.message;return;}
  if(data.session){msg.textContent="";await boot();}
  else msg.textContent="Conta criada. Confirme seu e-mail e depois faça login.";
});

$("#advisorLogout").addEventListener("click",async()=>{await db.auth.signOut();location.reload();});
boot();