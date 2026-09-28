import { db, STORAGE_BUCKET } from "./config.js";
import { $, escapeHTML, money, propertyTypeLabel, statusLabel } from "./common.js";

let currentUser=null;
let profile=null;
let plans=[];
let subscriptions=[];
let properties=[];
let renewalOffers={};
let countdownTimer=null;
let paymentWatcher=null;

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
function activeSubscription(){
  return subscriptions.find(s=>s.status==="active" && s.ends_at && new Date(s.ends_at)>new Date()) || null;
}
function latestRenewable(){
  return [...subscriptions]
    .filter(s=>s.status==="expired" || (s.ends_at && new Date(s.ends_at)<=new Date()))
    .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0] || null;
}
function adCountFor(subId){
  return properties.filter(p=>p.advisor_subscription_id===subId).length;
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

async function ensureProfile(user){
  const meta=user.user_metadata||{};
  const fallback={
    user_id:user.id,
    full_name:meta.full_name||user.email?.split("@")[0]||"Assessor",
    whatsapp:String(meta.whatsapp||"").replace(/\D/g,"")||null,
    company_name:meta.company_name||null,
    city:meta.city||null
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
      "Carregamento das assinaturas"
    ),
    withTimeout(
      db.from("properties")
        .select("*, property_media(*)")
        .eq("advisor_id",currentUser.id)
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento dos anúncios"
    )
  ]);

  const [plRes,subRes,adsRes]=results;
  plans=plRes.status==="fulfilled"?(plRes.value.data||[]):[];
  subscriptions=subRes.status==="fulfilled"?(subRes.value.data||[]):[];
  properties=adsRes.status==="fulfilled"?(adsRes.value.data||[]):[];

  const failures=results.filter(r=>r.status==="rejected");
  if(failures.length){
    console.warn("Alguns dados do painel demoraram para carregar:",failures);
  }

  renewalOffers={};
  const renewable=latestRenewable();
  if(renewable){
    try{
      const {data}=await withTimeout(
        db.rpc("get_or_create_renewal_offer",{p_subscription_id:renewable.id}),
        8000,
        "Carregamento da renovação"
      );
      const offer=Array.isArray(data)?data[0]:data;
      if(offer) renewalOffers[renewable.id]=offer;
    }catch(err){
      console.warn("Oferta de renovação não carregada:",err);
    }
  }

  return failures.length===0;
}

function remainingText(expiresAt){
  const ms=new Date(expiresAt)-new Date();
  if(ms<=0) return "00:00";
  const total=Math.floor(ms/1000);
  const min=String(Math.floor(total/60)).padStart(2,"0");
  const sec=String(total%60).padStart(2,"0");
  return `${min}:${sec}`;
}

function startOfferCountdown(){
  if(countdownTimer) clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    document.querySelectorAll("[data-offer-expires]").forEach(el=>{
      const expires=el.dataset.offerExpires;
      const ms=new Date(expires)-new Date();
      el.textContent=remainingText(expires);
      if(ms<=0){
        clearInterval(countdownTimer);
        renderPlans();
      }
    });
  },1000);
}

function renderPlans(){
  const active=activeSubscription();
  const renewable=latestRenewable();
  $("#advisorPlans").innerHTML=plans.map(plan=>{
    const isActive=active?.plan_id===plan.id;
    const canRenew=renewable?.plan_id===plan.id;
    const offer=canRenew?renewalOffers[renewable.id]:null;
    const offerActive=!!offer && offer.is_active && new Date(offer.expires_at)>new Date();
    const promoPrice=offerActive?Number(offer.promotional_price):Number(plan.price);
    return `
      <article class="advisor-plan-card ${isActive?"active":""}">
        <span class="advisor-plan-badge">${plan.ad_limit} anúncio${plan.ad_limit>1?"s":""}</span>
        <h3>${escapeHTML(plan.name)}</h3>
        <div class="advisor-plan-price">${money(plan.price,"BRL")}</div>
        <p>Validade de ${plan.validity_days} dias.</p>
        ${isActive?`<div class="plan-active-note">Ativo até ${fmtDate(active.ends_at)} • ${adCountFor(active.id)}/${plan.ad_limit} usados</div>`:""}
        ${canRenew && offerActive?`
          <div class="renew-price">
            <span>Oferta de renovação por mais 30 dias</span>
            <div><del>${money(offer.regular_price,"BRL")}</del><strong>${money(promoPrice,"BRL")}</strong></div>
            <small>Oferta válida por <b class="offer-countdown" data-offer-expires="${offer.expires_at}">${remainingText(offer.expires_at)}</b></small>
          </div>
          <button class="btn whatsapp full" data-buy="${plan.id}" data-renew="${renewable.id}" data-offer="${offer.offer_id}">Renovar pelo valor promocional</button>
        `:canRenew?`
          <div class="renew-price expired-offer">
            <span>Oferta promocional encerrada</span>
            <div><strong>${money(plan.price,"BRL")}</strong></div>
          </div>
          <button class="btn primary full" data-buy="${plan.id}" data-renew="${renewable.id}">Renovar por ${money(plan.price,"BRL")}</button>
        `:`
          <button class="btn primary full" data-buy="${plan.id}">Comprar via PIX</button>
        `}
      </article>`;
  }).join("");
  startOfferCountdown();
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
              <small class="listing-code">Código do anúncio: ${escapeHTML(String(p.listing_code||"").slice(0,8).toUpperCase())}</small>
            </div>
            <div class="advisor-ad-actions">
              <span class="pill ${expired?"pending":"paid"}">${expired?"FORA DO AR":"PUBLICADO"}</span>
              <button class="btn ghost compact" data-edit-ad="${p.id}">Editar</button>
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

function propertyModal(property=null){
  const active=activeSubscription();
  if(!property){
    if(!active){
      alert("Você precisa de um pacote ativo para publicar um imóvel.");
      return;
    }
    const plan=active.advertising_plans;
    if(adCountFor(active.id)>=Number(plan.ad_limit)){
      alert("Você já utilizou todos os anúncios disponíveis neste pacote.");
      return;
    }
  }
  showAdvisorModal(`
    <div class="modal-head"><div><p class="eyebrow">${property?"EDITAR ANÚNCIO":"NOVO ANÚNCIO"}</p><h2>${property?"Editar imóvel":"Cadastrar imóvel"}</h2></div><button class="icon-btn" data-close>✕</button></div>
    <form id="advisorPropertyForm" class="form-grid"><input type="hidden" name="id" value="${property?.id||""}">
      <label>Título<input name="title" required value="${escapeHTML(property?.title||"")}"></label>
      <label>Tipo<select name="property_type">${["apartamento","casa","monoambiente","kitnet","outro"].map(t=>`<option value="${t}" ${property?.property_type===t?"selected":""}>${propertyTypeLabel(t)}</option>`).join("")}</select></label>
      <label>Valor mensal<input name="price" type="number" min="0" step="0.01" required value="${property?.price??""}"></label>
      <label>Caução<input name="security_deposit" type="number" min="0" step="0.01" value="${property?.security_deposit??""}"></label>
      <label>Parcelamento da caução<select name="security_deposit_installment_allowed"><option value="false" ${!property?.security_deposit_installment_allowed?"selected":""}>Não</option><option value="true" ${property?.security_deposit_installment_allowed?"selected":""}>Sim</option></select></label>
      <label>Máximo de parcelas<input name="security_deposit_max_installments" type="number" min="2" max="24" value="${property?.security_deposit_max_installments??""}"></label>
      <label>Fechamento<select name="closing_mode"><option value="advisor" ${property?.closing_mode!=="direct_owner"?"selected":""}>Via assessoria</option><option value="direct_owner" ${property?.closing_mode==="direct_owner"?"selected":""}>Direto com o proprietário</option></select></label>
      <label>WhatsApp do anúncio<input name="contact_whatsapp" inputmode="tel" required value="${escapeHTML(property?.contact_whatsapp||profile?.whatsapp||"")}"></label>
      <label>Quartos<input name="bedrooms" type="number" min="0" value="${property?.bedrooms??""}"></label>
      <label>Banheiros<input name="bathrooms" type="number" min="0" value="${property?.bathrooms??""}"></label>
      <label>Mobília<select name="furnished"><option value="false" ${!property?.furnished?"selected":""}>Sem mobília</option><option value="true" ${property?.furnished?"selected":""}>Mobiliado</option></select></label>
      <label>Bairro<input name="neighborhood" value="${escapeHTML(property?.neighborhood||"")}"></label>
      <label>Cidade<input name="city" value="${escapeHTML(property?.city||profile?.city||"")}"></label>
      <label class="span-2">Endereço completo<input name="address" value="${escapeHTML(property?.address||"")}"></label>
      <label>Latitude<input name="latitude" type="number" step="0.0000001" value="${property?.latitude??""}"></label>
      <label>Longitude<input name="longitude" type="number" step="0.0000001" value="${property?.longitude??""}"></label>
      <label>Mostrar localização exata?<select name="show_exact_location"><option value="false" ${!property?.show_exact_location?"selected":""}>Não</option><option value="true" ${property?.show_exact_location?"selected":""}>Sim</option></select></label>
      <label>Status<select name="status"><option value="available" ${property?.status!=="rented"?"selected":""}>Disponível</option><option value="rented" ${property?.status==="rented"?"selected":""}>Alugado</option></select></label>
      <label class="span-2">Descrição<textarea name="description">${escapeHTML(property?.description||"")}</textarea></label>
      <label class="span-2">Adicionar fotos<input name="images" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple ${property?"":"required"}></label>
      ${property?`<div class="span-2 edit-expiry-lock">🔒 A validade permanece em <strong>${fmtDate(property.listing_expires_at)}</strong>. Editar não reinicia os 30 dias.</div>`:""}
      <div class="form-actions"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn primary" type="submit">${property?"Salvar alterações":"Publicar imóvel"}</button></div>
      <div id="advisorPropertyMessage" class="span-2 form-message"></div>
    </form>`);
}

async function saveProperty(form){
  const active=activeSubscription();
  const fd=new FormData(form);
  const id=fd.get("id")||null;
  const existing=id?properties.find(p=>p.id===id):null;
  if(!existing && !active) return;
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
    advisor_subscription_id:existing?.advisor_subscription_id || active?.id
  };
  const msg=$("#advisorPropertyMessage");
  msg.textContent=existing?"Salvando alterações...":"Publicando...";
  let propertyId=id;
  if(existing){
    delete row.advisor_id;
    delete row.advisor_subscription_id;
    delete row.is_published;
    const upd=await db.from("properties").update(row).eq("id",id).eq("advisor_id",currentUser.id);
    if(upd.error){msg.textContent=upd.error.message;return;}
  }else{
    const ins=await db.from("properties").insert(row).select("id").single();
    if(ins.error){msg.textContent=ins.error.message;return;}
    propertyId=ins.data.id;
  }
  const files=[...form.querySelector('input[name="images"]').files];
  let first=!(existing?.property_media||[]).some(m=>m.media_type==="image");
  for(const file of files){
    const safe=file.name.replace(/[^A-Za-z0-9._-]/g,"_");
    const path=`${currentUser.id}/${propertyId}/${crypto.randomUUID()}-${safe}`;
    const up=await db.storage.from(STORAGE_BUCKET).upload(path,file,{cacheControl:"3600",upsert:false});
    if(up.error){msg.textContent=up.error.message;return;}
    await db.from("property_media").insert({property_id:propertyId,media_type:"image",storage_path:path,is_cover:first,sort_order:first?0:10});
    first=false;
  }
  closeAdvisorModal();
  await loadData();
  renderPanel();
}

async function watchPaymentStatus(subscriptionId){
  if(paymentWatcher) clearInterval(paymentWatcher);

  let attempts=0;
  const maxAttempts=90; // ~3 minutos

  const check=async()=>{
    attempts++;

    try{
      const {data,error}=await db
        .from("advisor_subscriptions")
        .select("status,paid_at,starts_at,ends_at")
        .eq("id",subscriptionId)
        .maybeSingle();

      if(error) throw error;

      const statusEl=$("#pixStatus");
      if(data?.status==="active" || data?.status==="paid"){
        if(paymentWatcher){
          clearInterval(paymentWatcher);
          paymentWatcher=null;
        }

        if(statusEl){
          statusEl.innerHTML='<strong>Pagamento aprovado ✓</strong><span>Seu pacote foi liberado. Abrindo sua Área do Assessor...</span>';
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
          statusEl.innerHTML='<strong>Ainda aguardando confirmação.</strong><span>Se você já pagou, pode fechar esta janela. O pacote será liberado automaticamente assim que o Mercado Pago confirmar.</span>';
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

async function startPayment(planId,renewalOf=null,offerId=null){
  const cpf=prompt("Informe o CPF do pagador para gerar o PIX (somente números):");
  if(!cpf) return;
  const {data,error}=await db.functions.invoke("create-advisor-pix",{body:{plan_id:planId,renewal_of:renewalOf,renewal_offer_id:offerId,cpf}});
  if(error || !data || data.error){
    alert(data?.error || error?.message || "A integração PIX ainda está sendo finalizada.");
    return;
  }
  showAdvisorModal(`
    <div class="modal-head"><div><p class="eyebrow">PAGAMENTO PIX</p><h2>Concluir pagamento</h2></div><button class="icon-btn" data-close>✕</button></div>
    <div class="pix-box">
      <strong>Total: ${money(data.amount,"BRL")}</strong>
      ${data.discount_percent?'<span class="promo-label">Oferta promocional aplicada</span>':""}
      ${data.qr_code_base64?`<img class="pix-qr" src="data:image/png;base64,${data.qr_code_base64}" alt="QR Code PIX">`:""}
      ${data.qr_code?`<textarea id="pixCopy" readonly>${escapeHTML(data.qr_code)}</textarea><button class="btn primary" id="copyPix">Copiar PIX</button>`:""}
      <div id="pixStatus" class="pix-payment-status"><strong>Aguardando confirmação do pagamento...</strong><span>Assim que o Mercado Pago confirmar, esta tela será atualizada automaticamente.</span></div>
    </div>`);
  $("#copyPix")?.addEventListener("click",async()=>{await navigator.clipboard.writeText($("#pixCopy").value);$("#copyPix").textContent="PIX copiado ✓";});
  if(data.subscription_id) watchPaymentStatus(data.subscription_id);
}

async function enterAdvisorPanel(user){
  if(!user) throw new Error("Usuário não identificado após o login.");

  currentUser=user;

  // Mostra o painel imediatamente após a autenticação.
  $("#advisorAuth").classList.add("hidden");
  $("#advisorResetPassword").classList.add("hidden");
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
    $("#advisorAuth").classList.add("hidden");
    $("#advisorPanel").classList.add("hidden");
    $("#advisorResetPassword").classList.remove("hidden");
    return;
  }

  const {data:{user}}=await db.auth.getUser();
  currentUser=user;
  if(!user){
    $("#advisorAuth").classList.remove("hidden");
    $("#advisorPanel").classList.add("hidden");
    return;
  }
  await enterAdvisorPanel(user);
}

document.addEventListener("click",async e=>{
  const tab=e.target.closest("[data-auth-tab]");
  if(tab){
    document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b===tab));
    $("#advisorLoginForm").classList.toggle("hidden",tab.dataset.authTab!=="login");
    $("#advisorSignupForm").classList.toggle("hidden",tab.dataset.authTab!=="signup");
  }
  const buy=e.target.closest("[data-buy]");
  if(buy) await startPayment(buy.dataset.buy,buy.dataset.renew||null,buy.dataset.offer||null);
  if(e.target.closest("#newAdvisorProperty")) propertyModal();
  const edit=e.target.closest("[data-edit-ad]");
  if(edit){
    const item=properties.find(p=>p.id===edit.dataset.editAd);
    if(item?.listing_expires_at && new Date(item.listing_expires_at)<=new Date()){
      alert("Este anúncio expirou. Renove o pacote para voltar a editar e publicar o imóvel.");
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
  if(e.target.id==="advisorPropertyForm") await saveProperty(e.target);
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

db.auth.onAuthStateChange((event)=>{
  if(event==="PASSWORD_RECOVERY"){
    $("#advisorAuth").classList.add("hidden");
    $("#advisorPanel").classList.add("hidden");
    $("#advisorResetPassword").classList.remove("hidden");
  }
});

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

$("#advisorLogout").addEventListener("click",async()=>{await db.auth.signOut();location.reload();});
boot();